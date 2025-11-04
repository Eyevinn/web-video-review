const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const s3Service = require('./s3Service');

class VideoService {
  constructor() {
    if (process.env.FFMPEG_PATH) {
      ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
    }
    this.chunkDuration = parseInt(process.env.CHUNK_DURATION) || 10;
    this.segmentCache = new Map();
    this.thumbnailCache = new Map();
    this.cacheExpiry = 30 * 60 * 1000; // 30 minutes
    this.activeProcesses = new Map();
    this.encodingTimes = new Map(); // Track encoding performance per video
    this.nativeHlsCache = new Map(); // Track native HLS generation
    this.hlsGenerationInProgress = new Set(); // Track which videos are being processed
    this.currentlyLoadedVideo = null; // Track the currently loaded video to abort previous processes
    
    // Local file caching for source videos
    this.localFileCache = new Map(); // Track downloaded local files
    this.activeDownloads = new Map(); // Track ongoing downloads
    this.localCacheDir = process.env.LOCAL_CACHE_DIR || '/tmp/videoreview';
    this.maxLocalCacheSize = parseInt(process.env.MAX_LOCAL_CACHE_SIZE) || 10 * 1024 * 1024 * 1024; // 10GB default
    this.enableLocalCache = process.env.ENABLE_LOCAL_CACHE !== 'false'; // Enable by default
    
    // Create cache directory if it doesn't exist
    this.initializeCacheDirectory();
    
    // Detect platform and available hardware acceleration
    this.platform = os.platform();
    this.arch = os.arch();
    this.hwAccel = this.detectHardwareAcceleration();
    
    console.log(`Platform: ${this.platform} ${this.arch}`);
    console.log(`Hardware acceleration: ${this.hwAccel.type || 'software only'}`);
  }

  detectHardwareAcceleration() {
    // For macOS (Darwin) with Apple Silicon or Intel
    if (this.platform === 'darwin') {
      return {
        type: 'videotoolbox',
        encoder: 'h264_videotoolbox',
        preset: undefined, // VideoToolbox doesn't use presets like x264
        quality: '-q:v 65', // Use quality setting instead of CRF
        rateControl: '-realtime 1'
      };
    }
    
    // For Linux with NVIDIA GPU (would need additional detection)
    // if (this.platform === 'linux') {
    //   return {
    //     type: 'nvenc',
    //     encoder: 'h264_nvenc',
    //     preset: '-preset p4', // p1-p7, p4 is balanced
    //     quality: '-cq 23',
    //     rateControl: '-rc vbr'
    //   };
    // }
    
    // For Windows with hardware acceleration
    // if (this.platform === 'win32') {
    //   return {
    //     type: 'qsv', // Intel Quick Sync
    //     encoder: 'h264_qsv',
    //     preset: '-preset medium',
    //     quality: '-global_quality 23',
    //     rateControl: ''
    //   };
    // }
    
    // Fallback to software encoding
    return {
      type: 'software',
      encoder: 'libx264',
      preset: '-preset fast',
      quality: '-crf 23',
      rateControl: ''
    };
  }

  initializeCacheDirectory() {
    try {
      if (!fsSync.existsSync(this.localCacheDir)) {
        fsSync.mkdirSync(this.localCacheDir, { recursive: true });
        console.log(`Created local cache directory: ${this.localCacheDir}`);
      }
      console.log(`Local cache directory: ${this.localCacheDir} (max size: ${(this.maxLocalCacheSize / 1024 / 1024 / 1024).toFixed(1)}GB)`);
    } catch (error) {
      console.error('Failed to create cache directory:', error);
      this.enableLocalCache = false;
    }
  }

  getLocalFilePath(s3Key) {
    const hash = crypto.createHash('sha256').update(s3Key).digest('hex');
    const ext = path.extname(s3Key) || '.video';
    return path.join(this.localCacheDir, `${hash}${ext}`);
  }

  async ensureLocalFile(s3Key, requiredDuration = null, segmentStartTime = 0) {
    if (!this.enableLocalCache) {
      return null;
    }

    const localPath = this.getLocalFilePath(s3Key);
    
    // Check if file already exists locally
    if (fsSync.existsSync(localPath)) {
      const stats = fsSync.statSync(localPath);
      
      // If we need to check for sufficient data for early segments
      if (requiredDuration !== null) {
        const hasEnoughData = await this.checkSufficientDataForDuration(s3Key, localPath, requiredDuration);
        if (!hasEnoughData) {
          console.log(`[Local Cache] File doesn't have enough data for ${requiredDuration}s, downloading more...`);
          // Continue with download to get more data
        } else {
          // Update access time for LRU cleanup
          this.localFileCache.set(s3Key, {
            path: localPath,
            size: stats.size,
            lastAccessed: new Date(),
            downloadTime: this.localFileCache.get(s3Key)?.downloadTime || new Date()
          });
          
          console.log(`[Local Cache] Using cached file for ${s3Key} (sufficient data)`);
          return localPath;
        }
      } else {
        // Update access time for LRU cleanup
        this.localFileCache.set(s3Key, {
          path: localPath,
          size: stats.size,
          lastAccessed: new Date(),
          downloadTime: this.localFileCache.get(s3Key)?.downloadTime || new Date()
        });
        
        console.log(`[Local Cache] Using cached file for ${s3Key}`);
        return localPath;
      }
    }

    // Check if download is already in progress
    if (this.activeDownloads.has(s3Key)) {
      console.log(`[Local Cache] Waiting for ongoing download of ${s3Key}`);
      return await this.activeDownloads.get(s3Key);
    }

    // Start download - always do full download but prioritize getting enough data quickly
    console.log(`[Local Cache] Starting download of ${s3Key}${requiredDuration ? ` (need ${requiredDuration}s)` : ''}`);
    const downloadPromise = this.downloadFileToLocal(s3Key, localPath, requiredDuration);
    this.activeDownloads.set(s3Key, downloadPromise);

    try {
      const result = await downloadPromise;
      this.activeDownloads.delete(s3Key);
      return result;
    } catch (error) {
      this.activeDownloads.delete(s3Key);
      throw error;
    }
  }

  async downloadFileToLocal(s3Key, localPath, requiredDuration = null) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let hasResolved = false;
      
      try {
        const signedUrl = s3Service.getSignedUrl(s3Key, 3600);
        const writeStream = fsSync.createWriteStream(localPath);
        
        // Use signed URL to download via HTTP
        const https = require('https');
        const http = require('http');
        const protocol = signedUrl.startsWith('https:') ? https : http;
        
        const request = protocol.get(signedUrl, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`Download failed with status ${response.statusCode}`));
            return;
          }

          const totalSize = parseInt(response.headers['content-length'] || '0');
          let downloadedSize = 0;
          let lastSufficientCheck = 0;

          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            writeStream.write(chunk);
            
            // Check if we have sufficient data periodically (every 1MB downloaded)
            if (requiredDuration && !hasResolved && downloadedSize - lastSufficientCheck > 1024 * 1024) {
              lastSufficientCheck = downloadedSize;
              
              // Check if we have enough data asynchronously
              setImmediate(async () => {
                try {
                  const hasEnough = await this.checkSufficientDataForDuration(s3Key, localPath, requiredDuration);
                  if (hasEnough && !hasResolved) {
                    hasResolved = true;
                    const downloadTime = Date.now() - startTime;
                    const sizeMB = (downloadedSize / 1024 / 1024).toFixed(2);
                    
                    console.log(`[Local Cache] Early resolve - sufficient data for ${requiredDuration}s (${sizeMB}MB) in ${downloadTime}ms`);
                    
                    // Update cache tracking with partial data
                    this.localFileCache.set(s3Key, {
                      path: localPath,
                      size: downloadedSize,
                      lastAccessed: new Date(),
                      downloadTime: new Date(),
                      isPartial: true // Mark as partial download
                    });
                    
                    resolve(localPath);
                    // Continue downloading in background, don't destroy the stream
                  }
                } catch (error) {
                  console.warn(`[Local Cache] Error checking sufficient data during download:`, error.message);
                }
              });
            }
          });

          response.on('end', () => {
            writeStream.end();
            
            if (!hasResolved) {
              const downloadTime = Date.now() - startTime;
              const sizeMB = (downloadedSize / 1024 / 1024).toFixed(2);
              const speedMBps = (downloadedSize / 1024 / 1024 / (downloadTime / 1000)).toFixed(2);
              
              console.log(`[Local Cache] Complete download of ${s3Key} (${sizeMB}MB) in ${downloadTime}ms (${speedMBps}MB/s)`);
              
              // Update cache tracking with complete data
              this.localFileCache.set(s3Key, {
                path: localPath,
                size: downloadedSize,
                lastAccessed: new Date(),
                downloadTime: new Date(),
                isPartial: false // Mark as complete download
              });

              // Clean up cache if needed
              this.cleanupCacheIfNeeded();
              
              resolve(localPath);
            } else {
              // Update the existing cache entry to mark as complete
              const existing = this.localFileCache.get(s3Key);
              if (existing) {
                existing.size = downloadedSize;
                existing.isPartial = false;
                this.localFileCache.set(s3Key, existing);
              }
              
              console.log(`[Local Cache] Background download completed for ${s3Key} (${(downloadedSize / 1024 / 1024).toFixed(2)}MB)`);
              this.cleanupCacheIfNeeded();
            }
          });

          response.on('error', (error) => {
            if (!hasResolved) {
              writeStream.destroy();
              fsSync.unlink(localPath, () => {});
              reject(error);
            } else {
              console.warn(`[Local Cache] Background download error for ${s3Key}:`, error.message);
            }
          });
        });

        request.on('error', (error) => {
          if (!hasResolved) {
            writeStream.destroy();
            fsSync.unlink(localPath, () => {});
            reject(error);
          }
        });

        request.setTimeout(5 * 60 * 1000, () => {
          if (!hasResolved) {
            request.destroy();
            writeStream.destroy();
            fsSync.unlink(localPath, () => {});
            reject(new Error('Download timeout'));
          }
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  async checkSufficientDataForDuration(s3Key, localPath, requiredDuration) {
    try {
      // Use cached video info to avoid race conditions and repeated calls
      const videoInfoCacheKey = `videoInfo:${s3Key}`;
      let videoInfo;
      
      if (!this.videoInfoCache) {
        this.videoInfoCache = new Map();
      }
      
      if (this.videoInfoCache.has(videoInfoCacheKey)) {
        videoInfo = this.videoInfoCache.get(videoInfoCacheKey);
      } else {
        videoInfo = await this.getVideoInfo(s3Key);
        this.videoInfoCache.set(videoInfoCacheKey, videoInfo);
        
        // Clean up video info cache after 1 hour
        setTimeout(() => {
          this.videoInfoCache.delete(videoInfoCacheKey);
        }, 60 * 60 * 1000);
      }
      
      // More robust bitrate detection with better fallbacks
      let videoBitrate = 0;
      if (videoInfo.bitrate && videoInfo.bitrate > 0) {
        videoBitrate = videoInfo.bitrate;
      } else if (videoInfo.video?.bitrate && videoInfo.video.bitrate > 0) {
        videoBitrate = videoInfo.video.bitrate;
      } else if (videoInfo.size && videoInfo.duration) {
        // Calculate bitrate from file size and duration as fallback
        videoBitrate = Math.floor((videoInfo.size * 8) / videoInfo.duration);
      } else {
        // Conservative fallback for unknown bitrate
        videoBitrate = 8000000; // 8Mbps fallback (higher for safety)
      }
      
      const totalSize = videoInfo.size;
      
      // Check current file size
      const stats = fsSync.statSync(localPath);
      const currentSize = stats.size;
      
      // Calculate bytes needed for the duration with buffer for encoding overhead
      const bufferMultiplier = 2.0; // 100% extra buffer for safety
      const bytesPerSecond = videoBitrate / 8; // Convert bits to bytes
      const requiredBytes = Math.ceil(requiredDuration * bytesPerSecond * bufferMultiplier);
      const bytesNeeded = Math.min(requiredBytes, totalSize);
      
      const hasEnough = currentSize >= bytesNeeded;
      
      console.log(`[Data Check] Video: ${(videoBitrate/1000000).toFixed(1)}Mbps (${videoInfo.bitrate ? 'format' : videoInfo.video?.bitrate ? 'stream' : 'calculated'}), Current: ${(currentSize/1024/1024).toFixed(1)}MB, needed for ${requiredDuration}s: ${(bytesNeeded/1024/1024).toFixed(1)}MB, sufficient: ${hasEnough}`);
      
      return hasEnough;
    } catch (error) {
      console.error(`[Data Check] Error checking ${s3Key}:`, error.message);
      return false;
    }
  }

  cleanupCacheIfNeeded() {
    try {
      const totalSize = Array.from(this.localFileCache.values())
        .reduce((sum, file) => sum + file.size, 0);

      if (totalSize > this.maxLocalCacheSize) {
        console.log(`[Local Cache] Cache size (${(totalSize / 1024 / 1024 / 1024).toFixed(2)}GB) exceeds limit, cleaning up...`);
        
        // Sort by last accessed time (LRU)
        const sortedFiles = Array.from(this.localFileCache.entries())
          .sort(([,a], [,b]) => a.lastAccessed - b.lastAccessed);

        let removedSize = 0;
        const targetSize = this.maxLocalCacheSize * 0.8; // Clean down to 80% of max

        for (const [s3Key, fileInfo] of sortedFiles) {
          if (totalSize - removedSize <= targetSize) break;

          try {
            fsSync.unlinkSync(fileInfo.path);
            this.localFileCache.delete(s3Key);
            removedSize += fileInfo.size;
            console.log(`[Local Cache] Removed ${s3Key} (${(fileInfo.size / 1024 / 1024).toFixed(2)}MB)`);
          } catch (error) {
            console.error(`[Local Cache] Failed to remove ${s3Key}:`, error.message);
          }
        }

        console.log(`[Local Cache] Cleanup complete, removed ${(removedSize / 1024 / 1024 / 1024).toFixed(2)}GB`);
      }
    } catch (error) {
      console.error('[Local Cache] Cleanup failed:', error);
    }
  }

  async getVideoInfo(s3Key) {
    try {
      // Check cache first to avoid repeated ffprobe calls
      const videoInfoCacheKey = `videoInfo:${s3Key}`;
      
      if (!this.videoInfoCache) {
        this.videoInfoCache = new Map();
      }
      
      if (this.videoInfoCache.has(videoInfoCacheKey)) {
        return this.videoInfoCache.get(videoInfoCacheKey);
      }
      
      const signedUrl = s3Service.getSignedUrl(s3Key, 3600);
      
      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(signedUrl, (err, metadata) => {
          if (err) {
            reject(err);
            return;
          }
          
          const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
          const audioStream = metadata.streams.find(stream => stream.codec_type === 'audio');
          
          const info = {
            duration: parseFloat(metadata.format.duration),
            bitrate: parseInt(metadata.format.bit_rate),
            size: parseInt(metadata.format.size),
            format: metadata.format.format_name,
            video: videoStream ? {
              codec: videoStream.codec_name,
              width: videoStream.width,
              height: videoStream.height,
              fps: eval(videoStream.r_frame_rate),
              bitrate: parseInt(videoStream.bit_rate) || 0
            } : null,
            audio: audioStream ? {
              codec: audioStream.codec_name,
              sampleRate: parseInt(audioStream.sample_rate),
              channels: audioStream.channels,
              bitrate: parseInt(audioStream.bit_rate) || 0
            } : null
          };
          
          // Cache the video info for future use
          this.videoInfoCache.set(videoInfoCacheKey, info);
          
          // Clean up video info cache after 1 hour
          setTimeout(() => {
            this.videoInfoCache.delete(videoInfoCacheKey);
          }, 60 * 60 * 1000);
          
          resolve(info);
        });
      });
    } catch (error) {
      console.error('Error getting video info:', error);
      throw error;
    }
  }

  async streamVideoChunk(s3Key, startTime = 0, duration = null) {
    const signedUrl = s3Service.getSignedUrl(s3Key, 3600);
    
    // Get video info for dynamic frame rate detection
    const videoInfo = await this.getVideoInfo(s3Key);
    const sourceFps = (videoInfo && videoInfo.video && videoInfo.video.fps) ? Math.round(videoInfo.video.fps) : 25;
    console.log(`[Stream Chunk] Using source frame rate ${sourceFps}fps for SMPTE timecode`);
    
    const ffmpegArgs = [
      '-i', signedUrl,
      '-ss', startTime.toString(),
      '-c:v', 'libx264'  // Force software encoding for video filters
    ];

    // Use software encoding settings for timecode overlay compatibility
    ffmpegArgs.push('-preset', 'fast', '-crf', '23');
    
    ffmpegArgs.push(
      '-b:v', '1500k',
      '-maxrate', '1500k',
      '-bufsize', '3M',
      '-vf', `setpts=PTS-STARTPTS,drawtext=text='%{pts\\:hms}':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.8:x=w-tw-10:y=h-th-10`,
      '-r', '25',
      '-s', '1280x720',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ac', '2',
      '-ar', '44100',
      '-movflags', 'frag_keyframe+empty_moov+faststart',
      '-f', 'mp4',
      '-avoid_negative_ts', 'make_zero',
      '-threads', '0',
      'pipe:1'
    );

    if (duration) {
      ffmpegArgs.splice(4, 0, '-t', duration.toString());
    }

    console.log(`[Stream Chunk] FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    
    ffmpegProcess.stderr.on('data', (data) => {
      console.log(`[Stream Chunk] FFmpeg stderr: ${data}`);
    });

    return ffmpegProcess.stdout;
  }

  async generateHLSSegments(s3Key, segmentDuration = 10) {
    try {
      // Use FFmpeg native live HLS generation
      const hlsData = await this.generateNativeLiveHLS(s3Key, segmentDuration);
      return hlsData;
    } catch (error) {
      console.error('Error generating native live HLS playlist:', error);
      throw error;
    }
  }



  async generateNativeLiveHLS(s3Key, segmentDuration = 10) {
    const cacheKey = `nativehls:${s3Key}:${segmentDuration}`;
    
    // Check if native HLS is already being generated
    if (this.activeProcesses.has(cacheKey)) {
      return this.activeProcesses.get(cacheKey);
    }
    
    // Track HLS generation in progress
    this.hlsGenerationInProgress.add(s3Key);
    
    console.log(`Starting FFmpeg native live HLS generation for ${s3Key} with ${segmentDuration}s segments`);
    
    const processPromise = this._generateNativeLiveHLSInternal(s3Key, segmentDuration);
    this.activeProcesses.set(cacheKey, processPromise);
    
    try {
      const result = await processPromise;
      return result;
    } finally {
      this.activeProcesses.delete(cacheKey);
      this.hlsGenerationInProgress.delete(s3Key);
    }
  }

  async _generateNativeLiveHLSInternal(s3Key, segmentDuration = 10) {
    // Get video info for duration calculation
    const videoInfo = await this.getVideoInfo(s3Key);
    const hasAudio = videoInfo.audio !== null;
    
    // Determine if this is an MXF source file
    const isMxfSource = s3Key.toLowerCase().endsWith('.mxf');
    
    console.log(`[Native Live HLS] Video duration: ${videoInfo.duration}s, audio: ${hasAudio}`);
    
    if (isMxfSource) {
      console.log(`[Native Live HLS] Processing MXF file with special handling for duration and timing`);
    }
    
    // Create temporary directory for HLS output with better path sanitization
    const sanitizedKey = s3Key.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_{2,}/g, '_');
    const tempDir = path.join('/tmp/videoreview', 'live-hls', sanitizedKey);
    
    // Ensure base directory exists first
    const baseDir = path.join('/tmp/videoreview', 'live-hls');
    await fs.mkdir(baseDir, { recursive: true });
    
    // Clean up any existing directory for this video to start fresh
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore errors if directory doesn't exist
    }
    
    // Create the specific temp directory
    await fs.mkdir(tempDir, { recursive: true });
    console.log(`[Native Live HLS] Created temp directory: ${tempDir}`);
    
    const playlistPath = path.join(tempDir, 'playlist.m3u8');
    const segmentPattern = path.join(tempDir, 'segment%03d.ts');
    const thumbnailPattern = path.join(tempDir, 'thumb%03d.jpg');
    
    // Get input source - use streaming approach for better performance
    let inputSource;
    let useStreamingMode = false;
    
    if (this.enableLocalCache) {
      try {
        // Start download but don't wait for completion - use streaming read
        const requiredDuration = Math.max(60, segmentDuration * 6); // Need enough data to start
        const localFilePath = await this.ensureLocalFile(s3Key, requiredDuration);
        if (localFilePath && fsSync.existsSync(localFilePath)) {
          const stats = fsSync.statSync(localFilePath);
          const cacheEntry = this.localFileCache.get(s3Key);
          
          if (cacheEntry && cacheEntry.isPartial === false) {
            // Complete file available
            inputSource = localFilePath;
            console.log(`[Native Live HLS] Using complete cached file: ${localFilePath} (${(stats.size/1024/1024).toFixed(1)}MB)`);
          } else {
            // Partial file - use streaming mode
            inputSource = localFilePath;
            useStreamingMode = true;
            console.log(`[Native Live HLS] Using streaming mode with partial file: ${localFilePath} (${(stats.size/1024/1024).toFixed(1)}MB downloading...)`);
          }
        }
      } catch (error) {
        console.log(`[Native Live HLS] Local cache failed, using signed URL:`, error.message);
      }
    }
    
    if (!inputSource) {
      inputSource = s3Service.getSignedUrl(s3Key, 3600);
      console.log(`[Native Live HLS] Using signed URL approach`);
    }
    
    // Final validation: if using local file, warn about potential incomplete downloads
    if (inputSource.includes('/tmp/videoreview/')) {
      const stats = fsSync.statSync(inputSource);
      const cacheEntry = this.localFileCache.get(s3Key);
      const expectedSize = videoInfo.size;
      const isComplete = cacheEntry?.isPartial === false;
      const sizeMatch = expectedSize ? Math.abs(stats.size - expectedSize) < 1024 : 'Unknown';
      
      console.log(`[Native Live HLS] Local file validation:`);
      console.log(`  - Current size: ${(stats.size/1024/1024).toFixed(1)}MB`);
      console.log(`  - Expected size: ${expectedSize ? (expectedSize/1024/1024).toFixed(1) + 'MB' : 'Unknown'}`);
      console.log(`  - Size match: ${sizeMatch === true ? 'Yes' : sizeMatch === false ? 'No' : sizeMatch}`);
      console.log(`  - Download complete: ${isComplete ? 'Yes' : 'Unknown/No'}`);
      
      if (cacheEntry?.isPartial === true) {
        console.warn(`[Native Live HLS] WARNING: Using partial file for HLS generation - may result in truncated output`);
      }
      
      if (expectedSize && stats.size < expectedSize * 0.95) {
        console.warn(`[Native Live HLS] WARNING: File appears incomplete (${((stats.size/expectedSize)*100).toFixed(1)}% of expected size)`);
      }
    }
    
    // Build FFmpeg command for native live HLS generation
    let ffmpegArgs = [];
    
    // Input configuration with streaming mode support
    if (useStreamingMode) {
      // Add streaming-specific flags for reading from partially downloaded files
      ffmpegArgs.push(
        '-fflags', '+genpts+igndts',  // Generate timestamps and ignore input DTS
        '-avoid_negative_ts', 'make_zero',  // Handle timestamp issues
        '-thread_queue_size', '512',  // Larger thread queue for streaming
        '-analyzeduration', '2M',  // Reduce analysis time for faster startup
        '-probesize', '5M'  // Reduce probe size for faster startup
      );
      
      if (isMxfSource) {
        // Special handling for MXF streaming - these files need more patience
        ffmpegArgs.push(
          '-f', 'mxf',  // Force MXF format detection
          '-stream_loop', '-1'  // Loop indefinitely until EOF (allows waiting for more data)
        );
      }
      
      console.log(`[Native Live HLS] Using streaming mode flags for concurrent download/processing`);
    }
    
    if (hasAudio) {
      ffmpegArgs.push('-i', inputSource);
    } else {
      // Add silent audio for video-only sources
      ffmpegArgs.push(
        '-f', 'lavfi',
        '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
        '-i', inputSource
      );
    }
    
    // Video encoding - force software for video filters compatibility
    ffmpegArgs.push('-c:v', 'libx264');
    
    // Software encoding quality settings for video filter compatibility
    ffmpegArgs.push(
      '-preset', 'fast',
      '-crf', '23'
    );
    
    // Audio encoding
    ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k');
    
    // Note: Stream mapping will be done after filter_complex to avoid conflicts
    
    // Duration control for streaming mode
    if (useStreamingMode) {
      // Use the full expected duration to prevent premature termination
      if (videoInfo.duration && videoInfo.duration > 0) {
        ffmpegArgs.push('-t', videoInfo.duration.toString());
        console.log(`[Native Live HLS] Setting duration limit to ${videoInfo.duration}s for streaming mode`);
      }
    }
    
    // Use filter_complex for multiple outputs with different filters
    const sourceFps = (videoInfo && videoInfo.video && videoInfo.video.fps) ? Math.round(videoInfo.video.fps) : 25;
    console.log(`[Native Live HLS] Using source frame rate ${sourceFps}fps for SMPTE timecode`);
    
    const inputLabel = hasAudio ? '0:v:0' : '1:v:0';
    const videoInputForFilter = hasAudio ? '0:v' : '1:v';
    const thumbnailOffset = segmentDuration / 2;
    const maxThumbnails = Math.ceil(videoInfo.duration / segmentDuration);
    
    // Complex filter graph: split input, apply different filters to each branch
    // Use setpts to reset timestamps and basic SMPTE format
    const filterComplex = [
      `[${videoInputForFilter}]split=2[v1][v2]`,
      `[v1]setpts=PTS-STARTPTS,scale=1280:720,drawtext=text='%{pts\\:hms}':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.8:x=w-tw-10:y=h-th-10[hls]`,
      `[v2]fps=1/${segmentDuration},scale=320:180[thumbs]`
    ].join(';');
    
    ffmpegArgs.push(
      '-filter_complex', filterComplex,
      '-map', '[hls]',
      '-map', hasAudio ? '0:a:0' : '0:a:0',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-r', '25',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level', '4.0',
      '-vsync', 'cfr',
      '-f', 'hls',
      '-hls_time', segmentDuration.toString(),
      '-hls_playlist_type', 'event',
      '-hls_segment_type', 'mpegts',
      '-hls_flags', 'split_by_time+independent_segments',
      '-force_key_frames', `expr:gte(t,n_forced*${segmentDuration})`,
      '-hls_segment_filename', segmentPattern,
      playlistPath,
      '-map', '[thumbs]',
      '-ss', thumbnailOffset.toString(),
      '-frames:v', maxThumbnails.toString(),
      '-q:v', '3',
      '-f', 'image2',
      '-y',
      thumbnailPattern
    );
    
    console.log(`[Native Live HLS] Video duration: ${videoInfo.duration}s, Segment duration: ${segmentDuration}s`);
    console.log(`[Native Live HLS] Expected ${maxThumbnails} thumbnails (Math.ceil(${videoInfo.duration}/${segmentDuration}))`);
    console.log(`[Native Live HLS] Thumbnails will be extracted at: ${Array.from({length: maxThumbnails}, (_, i) => `${(thumbnailOffset + i * segmentDuration).toFixed(1)}s`).join(', ')}`);
    console.log(`[Native Live HLS] Video input for filter: ${videoInputForFilter} (hasAudio: ${hasAudio})`);
    console.log(`[Native Live HLS] Filter complex: ${filterComplex}`);
    console.log(`[Native Live HLS] FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);
    
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ffmpegArgs);
      
      let stderr = '';
      let isResolved = false;
      
      // Set up timeout to resolve early for live streaming
      const earlyResolveTimeout = setTimeout(() => {
        if (!isResolved && fsSync.existsSync(playlistPath)) {
          isResolved = true;
          
          // Store the temp directory path for segment serving
          if (!this.nativeHlsCache) {
            this.nativeHlsCache = new Map();
          }
          if (!this.hlsGenerationInProgress) {
            this.hlsGenerationInProgress = new Set();
          }
          this.nativeHlsCache.set(s3Key, {
            tempDir,
            segmentDuration,
            timestamp: Date.now(),
            createdAt: Date.now(),
            ffmpegProcess: ffmpeg
          });
          
          // Read initial playlist
          const playlist = fsSync.readFileSync(playlistPath, 'utf8');
          
          console.log(`[Native Live HLS] Early resolve with initial segments available`);
          
          resolve({
            playlist,
            segmentCount: 0, // Will be updated as segments are created
            duration: videoInfo.duration,
            isLive: true,
            tempDir
          });
        }
      }, 3000); // Resolve after 3 seconds if playlist exists
      
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
        
        // Check for filter errors
        if (stderr.includes('filter') && (stderr.includes('error') || stderr.includes('Error') || stderr.includes('invalid') || stderr.includes('Invalid'))) {
          console.error(`[Native Live HLS] Filter error detected: ${data.toString()}`);
        }
        
        // Check for drawtext errors specifically
        if (stderr.includes('drawtext') && (stderr.includes('error') || stderr.includes('Error'))) {
          console.error(`[Native Live HLS] Drawtext filter error: ${data.toString()}`);
        }
        
        // Check for directory/file access errors and try to recreate directory
        if (stderr.includes('No such file or directory') || stderr.includes('Failed to open file')) {
          console.warn(`[Native Live HLS] Directory/file access error detected: ${data.toString()}`);
          
          // Try to recreate the temp directory if it was deleted
          const fsSync = require('fs');
          if (!fsSync.existsSync(tempDir)) {
            try {
              fsSync.mkdirSync(tempDir, { recursive: true });
              console.log(`[Native Live HLS] Recreated missing temp directory: ${tempDir}`);
            } catch (error) {
              console.error(`[Native Live HLS] Failed to recreate temp directory: ${error.message}`);
            }
          }
        }
        
        // Check for segment and thumbnail creation in stderr output
        const segmentMatch = stderr.match(/Opening.*segment(\d+)\.ts/);
        if (segmentMatch) {
          console.log(`[Native Live HLS] Segment ${segmentMatch[1]} being created`);
        }
        
        const thumbMatch = stderr.match(/Writing application.*thumb(\d+)\.jpg/);
        if (thumbMatch) {
          console.log(`[Native Live HLS] Thumbnail ${thumbMatch[1]} being created`);
        }
        
        // Enhanced logging for MXF processing
        if (isMxfSource) {
          if (stderr.includes('time=')) {
            const timeMatch = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
            if (timeMatch) {
              console.log(`[Native Live HLS] MXF Progress: ${timeMatch[1]} / ${Math.floor(videoInfo.duration/3600)}:${Math.floor((videoInfo.duration%3600)/60).toString().padStart(2,'0')}:${Math.floor(videoInfo.duration%60).toString().padStart(2,'0')}`);
            }
          }
          
          if (stderr.includes('Conversion failed') || stderr.includes('error')) {
            console.error(`[Native Live HLS] MXF Processing error: ${stderr.slice(-200)}`);
          }
        }
      });
      
      ffmpeg.on('close', async (code) => {
        clearTimeout(earlyResolveTimeout);
        
        if (isResolved) {
          console.log(`[Native Live HLS] FFmpeg process completed with code ${code}`);
          return;
        }
        
        if (code !== 0) {
          console.error(`[Native Live HLS] FFmpeg failed with code ${code}:`, stderr);
          
          // Check if this might be due to incomplete file download
          if (stderr.includes('End of file') || stderr.includes('Invalid data found') || stderr.includes('truncated')) {
            console.error(`[Native Live HLS] Error suggests incomplete file download. Expected duration: ${videoInfo.duration}s`);
            if (inputSource.includes('/tmp/videoreview/')) {
              const stats = fsSync.statSync(inputSource);
              console.error(`[Native Live HLS] Local file size: ${(stats.size/1024/1024).toFixed(1)}MB`);
            }
          }
          
          reject(new Error(`Native Live HLS generation failed: ${stderr}`));
          return;
        }
        
        try {
          // Read the final playlist
          const playlist = await fs.readFile(playlistPath, 'utf8');
          
          // Count segments
          const segmentCount = (playlist.match(/segment\d+\.ts/g) || []).length;
          
          console.log(`[Native Live HLS] Generated ${segmentCount} segments successfully`);
          
          // Store the temp directory path for segment serving
          if (!this.nativeHlsCache) {
            this.nativeHlsCache = new Map();
          }
          if (!this.hlsGenerationInProgress) {
            this.hlsGenerationInProgress = new Set();
          }
          this.nativeHlsCache.set(s3Key, {
            tempDir,
            segmentDuration,
            timestamp: Date.now(),
            createdAt: Date.now()
          });
          
          // Clean up after 1 hour
          setTimeout(() => {
            this.cleanupNativeHLSCache(s3Key);
          }, 60 * 60 * 1000);
          
          resolve({
            playlist,
            segmentCount,
            duration: videoInfo.duration,
            isLive: true,
            tempDir
          });
        } catch (error) {
          reject(error);
        }
      });
      
      ffmpeg.on('error', (error) => {
        clearTimeout(earlyResolveTimeout);
        console.error(`[Native Live HLS] FFmpeg spawn error:`, error);
        reject(error);
      });
    });
  }

  async cleanupNativeHLSCache(s3Key) {
    if (this.nativeHlsCache && this.nativeHlsCache.has(s3Key)) {
      const cacheEntry = this.nativeHlsCache.get(s3Key);
      
      // Kill FFmpeg process if still running
      if (cacheEntry.ffmpegProcess && !cacheEntry.ffmpegProcess.killed) {
        cacheEntry.ffmpegProcess.kill();
        console.log(`[Native Live HLS] Killed FFmpeg process for ${s3Key}`);
      }
      
      try {
        await fs.rm(cacheEntry.tempDir, { recursive: true, force: true });
        console.log(`[Native Live HLS] Cleaned up cache for ${s3Key}`);
      } catch (error) {
        console.warn(`[Native Live HLS] Failed to cleanup cache for ${s3Key}:`, error.message);
      }
      this.nativeHlsCache.delete(s3Key);
    }
  }

  abortAllFFmpegProcesses(s3Key = null) {
    console.log(`[FFmpeg Abort] ${s3Key ? `Aborting all FFmpeg processes for ${s3Key}` : 'Aborting all FFmpeg processes'}`);
    
    let abortedCount = 0;
    
    // Abort active processes
    if (this.activeProcesses) {
      const processesToAbort = [];
      for (const [cacheKey, processPromise] of this.activeProcesses.entries()) {
        if (!s3Key || cacheKey.includes(s3Key)) {
          processesToAbort.push(cacheKey);
        }
      }
      
      for (const cacheKey of processesToAbort) {
        try {
          this.activeProcesses.delete(cacheKey);
          abortedCount++;
          console.log(`[FFmpeg Abort] Removed active process: ${cacheKey}`);
        } catch (error) {
          console.warn(`[FFmpeg Abort] Error removing active process ${cacheKey}:`, error.message);
        }
      }
    }
    
    // Abort HLS generation processes and clean up cache
    if (this.nativeHlsCache) {
      const hlsKeysToAbort = [];
      for (const [hlsKey, cacheEntry] of this.nativeHlsCache.entries()) {
        if (!s3Key || hlsKey === s3Key) {
          hlsKeysToAbort.push(hlsKey);
        }
      }
      
      for (const hlsKey of hlsKeysToAbort) {
        try {
          const cacheEntry = this.nativeHlsCache.get(hlsKey);
          if (cacheEntry && cacheEntry.ffmpegProcess && !cacheEntry.ffmpegProcess.killed) {
            cacheEntry.ffmpegProcess.kill('SIGTERM');
            abortedCount++;
            console.log(`[FFmpeg Abort] Killed HLS FFmpeg process for ${hlsKey}`);
            
            // Force kill after 2 seconds if still running
            setTimeout(() => {
              if (!cacheEntry.ffmpegProcess.killed) {
                cacheEntry.ffmpegProcess.kill('SIGKILL');
                console.log(`[FFmpeg Abort] Force killed stubborn FFmpeg process for ${hlsKey}`);
              }
            }, 2000);
          }
          
          // Mark temp directory for cleanup but don't delete immediately
          if (cacheEntry && cacheEntry.tempDir) {
            // Give FFmpeg more time to gracefully shut down before cleaning up
            setTimeout(async () => {
              try {
                // Double-check that the process is really dead before cleanup
                if (cacheEntry.ffmpegProcess && cacheEntry.ffmpegProcess.killed) {
                  await fs.rm(cacheEntry.tempDir, { recursive: true, force: true });
                  console.log(`[FFmpeg Abort] Cleaned up temp directory for ${hlsKey}`);
                } else {
                  console.log(`[FFmpeg Abort] Skipping temp directory cleanup - process may still be running for ${hlsKey}`);
                }
              } catch (error) {
                console.warn(`[FFmpeg Abort] Failed to cleanup temp directory for ${hlsKey}:`, error.message);
              }
            }, 5000); // Wait 5 seconds before cleanup to allow process to die gracefully
          }
          
          this.nativeHlsCache.delete(hlsKey);
        } catch (error) {
          console.warn(`[FFmpeg Abort] Error aborting HLS process for ${hlsKey}:`, error.message);
        }
      }
    }
    
    // Remove from HLS generation tracking
    if (this.hlsGenerationInProgress) {
      if (s3Key) {
        this.hlsGenerationInProgress.delete(s3Key);
      } else {
        this.hlsGenerationInProgress.clear();
      }
    }
    
    // Kill any remaining FFmpeg processes using system kill
    if (!s3Key) {
      try {
        const { spawn } = require('child_process');
        const killProcess = spawn('pkill', ['-f', 'ffmpeg.*videoreview']);
        killProcess.on('close', (code) => {
          if (code === 0) {
            console.log(`[FFmpeg Abort] Killed system FFmpeg processes related to videoreview`);
          }
        });
      } catch (error) {
        console.warn(`[FFmpeg Abort] Could not kill system FFmpeg processes:`, error.message);
      }
    }
    
    console.log(`[FFmpeg Abort] Completed - ${abortedCount} processes aborted${s3Key ? ` for ${s3Key}` : ''}`);
    return abortedCount;
  }


  async loadNewVideo(s3Key) {
    // Check if this is a different video than currently loaded
    if (this.currentlyLoadedVideo && this.currentlyLoadedVideo !== s3Key) {
      console.log(`Switching from ${this.currentlyLoadedVideo} to ${s3Key} - aborting all FFmpeg processes`);
      
      // Abort all FFmpeg processes when switching videos
      this.abortAllFFmpegProcesses();
      
      // Clear any downloads for the previous video
      if (this.activeDownloads && this.activeDownloads.has(this.currentlyLoadedVideo)) {
        try {
          this.activeDownloads.delete(this.currentlyLoadedVideo);
          console.log(`Cancelled download for ${this.currentlyLoadedVideo}`);
        } catch (error) {
          console.warn(`Error cancelling download:`, error.message);
        }
      }
    } else if (this.currentlyLoadedVideo === s3Key) {
      console.log(`Same video ${s3Key} - keeping existing processes`);
    } else {
      console.log(`Loading first video ${s3Key}`);
    }
    
    // Update currently loaded video
    this.currentlyLoadedVideo = s3Key;
  }





  async streamSegment(s3Key, segmentIndex, segmentDuration = 10) {
    // Only serve native HLS segments generated by FFmpeg
    if (this.nativeHlsCache && this.nativeHlsCache.has(s3Key)) {
      const hlsCacheEntry = this.nativeHlsCache.get(s3Key);
      const segmentPath = path.join(hlsCacheEntry.tempDir, `segment${segmentIndex.toString().padStart(3, '0')}.ts`);
      
      if (fsSync.existsSync(segmentPath)) {
        console.log(`[Segment ${segmentIndex}] Serving native HLS segment from ${segmentPath}`);
        return require('fs').createReadStream(segmentPath);
      } else {
        console.log(`[Segment ${segmentIndex}] Native HLS segment not found: ${segmentPath}`);
      }
    }
    
    // If no native HLS segment found, return error
    throw new Error(`Segment ${segmentIndex} not available for ${s3Key}. Native HLS generation may still be in progress.`);
  }

  

  async preEncodeAheadSegments(s3Key, currentSegmentIndex, segmentDuration) {
    // Legacy pre-encoding is not needed with native HLS generation
    // All segments are generated by FFmpeg in real-time
    console.log(`[Pre-encode] Skipping legacy pre-encoding - using native HLS generation`);
  }

  async encodeAndCacheSegment(s3Key, segmentIndex, segmentDuration) {
    // Legacy segment pre-encoding is no longer supported with native HLS only
    console.log(`[Pre-encode] Skipping legacy pre-encoding for segment ${segmentIndex} - using native HLS only`);
  }


  async getSegmentThumbnails(s3Key, segmentDuration = 10) {
    try {
      const info = await this.getVideoInfo(s3Key);
      const segmentCount = Math.ceil(info.duration / segmentDuration);
      const thumbnails = [];
      
      // Check if we have native HLS cache with thumbnails
      const thumbnailsHlsCacheEntry = this.nativeHlsCache && this.nativeHlsCache.get(s3Key);
      
      for (let i = 0; i < segmentCount; i++) {
        let thumbnailData = null;
        
        // First, try to get thumbnail from native HLS generation
        if (thumbnailsHlsCacheEntry) {
          const thumbnailPath = path.join(thumbnailsHlsCacheEntry.tempDir, `thumb${i.toString().padStart(3, '0')}.jpg`);
          if (fsSync.existsSync(thumbnailPath)) {
            try {
              const thumbnailBuffer = fsSync.readFileSync(thumbnailPath);
              const base64Data = thumbnailBuffer.toString('base64');
              thumbnailData = {
                segmentIndex: i,
                time: i * segmentDuration + (segmentDuration / 2),
                data: `data:image/jpeg;base64,${base64Data}`,
                cached: Date.now(),
                source: 'native-hls'
              };
              console.log(`[Thumbnails] Using native HLS thumbnail for segment ${i}`);
            } catch (error) {
              console.warn(`[Thumbnails] Failed to read native thumbnail ${i}:`, error.message);
            }
          }
        }
        
        // Fallback to placeholder if native HLS thumbnail not available
        if (!thumbnailData) {
          thumbnailData = {
            segmentIndex: i,
            time: i * segmentDuration + (segmentDuration / 2),
            data: null,
            cached: null,
            source: 'placeholder'
          };
        }
        
        thumbnails.push(thumbnailData);
      }
      
      return thumbnails;
    } catch (error) {
      console.error('Error getting segment thumbnails:', error);
      throw error;
    }
  }

  async getVideoProgress(s3Key) {
    try {
      let downloadProgress = 0;
      let processingProgress = 0;
      let estimatedTimeRemaining = null;
      let status = 'initializing';
      let message = 'Preparing video...';


      // Progress endpoint is now read-only - HLS generation is triggered by playlist requests

      // Check download progress
      const cacheEntry = this.localFileCache.get(s3Key);
      if (cacheEntry) {
        // Try to get video info to determine total size if not available in cache
        let totalSize = cacheEntry.totalSize;
        if (!totalSize) {
          try {
            const videoInfo = await this.getVideoInfo(s3Key);
            totalSize = videoInfo.size;
          } catch (error) {
            console.warn('Could not get video size for download progress:', error.message);
          }
        }
        
        if (cacheEntry.isPartial === false) {
          downloadProgress = 100;
          status = 'downloaded';
          message = 'Download complete';
        } else if (cacheEntry.size && totalSize) {
          downloadProgress = Math.round((cacheEntry.size / totalSize) * 100);
          status = 'downloading';
          message = `Downloading... ${downloadProgress}%`;
          
          
          // Estimate remaining time based on download speed
          if (cacheEntry.downloadTime) {
            const elapsed = Date.now() - cacheEntry.downloadTime.getTime();
            if (elapsed > 0) {
              const bytesPerMs = cacheEntry.size / elapsed;
              const remainingBytes = totalSize - cacheEntry.size;
              const estimatedMs = remainingBytes / bytesPerMs;
              estimatedTimeRemaining = Math.ceil(estimatedMs / 1000);
            }
          }
        }
      }

      // Check if generation is in progress but no cache entry yet
      if (this.hlsGenerationInProgress && this.hlsGenerationInProgress.has(s3Key) && 
          this.nativeHlsCache && !this.nativeHlsCache.get(s3Key)) {
        status = 'starting';
        message = 'Starting video processing...';
      }

      // Check processing progress (HLS generation)
      const updatedHlsCacheEntry = this.nativeHlsCache && this.nativeHlsCache.get(s3Key);
      if (updatedHlsCacheEntry) {
        try {
          const videoInfo = await this.getVideoInfo(s3Key);
          const expectedSegments = Math.ceil(videoInfo.duration / 10); // Assuming 10s segments
          
          // Count existing segments
          let existingSegments = 0;
          for (let i = 0; i < expectedSegments; i++) {
            const segmentPath = path.join(updatedHlsCacheEntry.tempDir, `segment${i.toString().padStart(3, '0')}.ts`);
            if (fsSync.existsSync(segmentPath)) {
              existingSegments++;
            }
          }
          
          processingProgress = Math.round((existingSegments / expectedSegments) * 100);
          
          if (existingSegments >= 3) {
            status = 'ready';
            message = 'Ready to play';
          } else if (existingSegments > 0) {
            status = 'processing';
            message = `Processing segments... ${existingSegments}/${expectedSegments}`;
            
            // Estimate processing time remaining
            if (!estimatedTimeRemaining && existingSegments > 0) {
              const segmentsPerSecond = existingSegments / ((Date.now() - updatedHlsCacheEntry.createdAt) / 1000);
              const remainingSegments = Math.max(3 - existingSegments, 0); // Need at least 3 to start
              estimatedTimeRemaining = Math.ceil(remainingSegments / segmentsPerSecond);
            }
          }
        } catch (error) {
          console.warn('Error calculating processing progress:', error);
        }
      }

      // Overall progress calculation
      let overallProgress = 0;
      if (status === 'ready') {
        overallProgress = 100;
      } else if (status === 'processing') {
        overallProgress = Math.round(50 + (processingProgress * 0.5)); // 50% for download + 50% for processing
      } else if (status === 'downloading') {
        overallProgress = Math.round(downloadProgress * 0.5); // First 50% is download
      }

      const result = {
        status,
        message,
        downloadProgress,
        processingProgress,
        overallProgress,
        estimatedTimeRemaining,
        ready: status === 'ready'
      };
      
      return result;
    } catch (error) {
      console.error('Error getting video progress:', error);
      return {
        status: 'error',
        message: 'Error checking progress',
        downloadProgress: 0,
        processingProgress: 0,
        overallProgress: 0,
        estimatedTimeRemaining: null,
        ready: false
      };
    }
  }

}

module.exports = new VideoService();