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
    this.debugLogging = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development'; // Debug logging control
    
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
        quality: '-q:v 23', // Better quality setting (23 is good, 65 was too low)
        rateControl: '', // Remove realtime flag for complex processing
        fallback: {
          encoder: 'libx264',
          preset: '-preset medium',
          quality: '-crf 23',
          rateControl: ''
        }
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
    
    // Fallback to software encoding with memory optimizations
    return {
      type: 'software-lowmem',
      encoder: 'libx264',
      preset: process.env.FFMPEG_PRESET || '-preset veryfast',
      quality: process.env.FFMPEG_CRF || '-crf 25',
      rateControl: '',
      threads: Math.min(parseInt(process.env.FFMPEG_THREADS || '2'), os.cpus().length),
      x264opts: 'sliced-threads:ref=1:bframes=0:me=dia:subme=1:trellis=0',
      bufsize: process.env.FFMPEG_BUFSIZE || '1M',
      maxrate: process.env.FFMPEG_MAXRATE || '1000k'
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
          this.debugLog(`[Local Cache] File doesn't have enough data for ${requiredDuration}s, checking if download in progress...`);
          
          // Check if download is in progress - if so, wait progressively
          if (this.activeDownloads.has(s3Key)) {
            return await this.waitForSufficientData(s3Key, localPath, requiredDuration);
          }
          
          // No download in progress, continue with new download
        } else {
          // Update access time for LRU cleanup
          this.localFileCache.set(s3Key, {
            path: localPath,
            size: stats.size,
            lastAccessed: new Date(),
            downloadTime: this.localFileCache.get(s3Key)?.downloadTime || new Date()
          });
          
          this.debugLog(`[Local Cache] Using cached file for ${s3Key} (sufficient data)`);
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
        
        this.debugLog(`[Local Cache] Using cached file for ${s3Key}`);
        return localPath;
      }
    }

    // Check if download is already in progress
    if (this.activeDownloads.has(s3Key)) {
      this.debugLog(`[Local Cache] Waiting for ongoing download of ${s3Key}`);
      
      // If we need a specific duration, wait progressively instead of waiting for complete download
      if (requiredDuration !== null) {
        return await this.waitForSufficientData(s3Key, localPath, requiredDuration);
      }
      
      return await this.activeDownloads.get(s3Key);
    }

    // Start download - always do full download but prioritize getting enough data quickly
    this.debugLog(`[Local Cache] Starting download of ${s3Key}${requiredDuration ? ` (need ${requiredDuration}s)` : ''}`);
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

  async waitForSufficientData(s3Key, localPath, requiredDuration, maxWaitMs = 30000) {
    const startTime = Date.now();
    const checkInterval = 500; // Check every 500ms
    
    this.debugLog(`[Local Cache] Progressively waiting for sufficient data for ${requiredDuration}s from ${s3Key}`);
    
    return new Promise((resolve, reject) => {
      const checkData = async () => {
        try {
          // Check if file exists and has sufficient data
          if (fsSync.existsSync(localPath)) {
            const hasEnough = await this.checkSufficientDataForDuration(s3Key, localPath, requiredDuration);
            if (hasEnough) {
              const waitTime = Date.now() - startTime;
              this.debugLog(`[Local Cache] Sufficient data available after ${waitTime}ms progressive wait`);
              
              // Update cache with current partial file, preserving existing metadata
              const stats = fsSync.statSync(localPath);
              const existingEntry = this.localFileCache.get(s3Key) || {};
              
              // Only update if our file size is newer/larger than what's already cached
              if (!existingEntry.size || stats.size >= existingEntry.size) {
                this.localFileCache.set(s3Key, {
                  ...existingEntry, // Preserve existing data like totalSize, original downloadTime
                  path: localPath,
                  size: stats.size,
                  lastAccessed: new Date(),
                  isPartial: true // Keep as partial since we returned early with sufficient data
                });
              }
              
              return resolve(localPath);
            }
          }
          
          // Check if we've exceeded max wait time
          const elapsed = Date.now() - startTime;
          if (elapsed >= maxWaitMs) {
            this.debugLog(`[Local Cache] Progressive wait timeout after ${elapsed}ms, falling back to complete download`);
            // Fall back to waiting for complete download
            if (this.activeDownloads.has(s3Key)) {
              return resolve(await this.activeDownloads.get(s3Key));
            } else {
              return reject(new Error(`Download not found after timeout for ${s3Key}`));
            }
          }
          
          // Continue checking
          setTimeout(checkData, checkInterval);
          
        } catch (error) {
          this.warnLog(`[Local Cache] Error during progressive wait:`, error.message);
          // Fall back to complete download wait
          if (this.activeDownloads.has(s3Key)) {
            return resolve(await this.activeDownloads.get(s3Key));
          } else {
            return reject(error);
          }
        }
      };
      
      // Start checking immediately
      checkData();
    });
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
                    
                    this.debugLog(`[Local Cache] Early resolve - sufficient data for ${requiredDuration}s (${sizeMB}MB) in ${downloadTime}ms`);
                    
                    // Update cache tracking with partial data
                    this.localFileCache.set(s3Key, {
                      path: localPath,
                      size: downloadedSize,
                      totalSize: totalSize, // Store total size for progress calculation
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
              
              this.infoLog(`[Local Cache] Complete download of ${s3Key} (${sizeMB}MB) in ${downloadTime}ms (${speedMBps}MB/s`);
              
              // Update cache tracking with complete data
              this.localFileCache.set(s3Key, {
                path: localPath,
                size: downloadedSize,
                totalSize: totalSize, // Store total size for progress calculation
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
          const audioStreams = metadata.streams.filter(stream => stream.codec_type === 'audio');
          const primaryAudioStream = audioStreams[0]; // Use first audio stream as primary
          
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
            audio: primaryAudioStream ? {
              codec: primaryAudioStream.codec_name,
              sampleRate: parseInt(primaryAudioStream.sample_rate),
              channels: primaryAudioStream.channels,
              channelLayout: primaryAudioStream.channel_layout || this._getChannelLayoutFromChannels(primaryAudioStream.channels),
              bitrate: parseInt(primaryAudioStream.bit_rate) || 0,
              bitsPerSample: primaryAudioStream.bits_per_sample || null,
              language: primaryAudioStream.tags?.language || null,
              title: primaryAudioStream.tags?.title || null
            } : null,
            audioStreams: audioStreams.length > 0 ? audioStreams.map((stream, index) => ({
              index: index,
              codec: stream.codec_name,
              sampleRate: parseInt(stream.sample_rate),
              channels: stream.channels,
              channelLayout: stream.channel_layout || this._getChannelLayoutFromChannels(stream.channels),
              bitrate: parseInt(stream.bit_rate) || 0,
              bitsPerSample: stream.bits_per_sample || null,
              language: stream.tags?.language || null,
              title: stream.tags?.title || null,
              duration: parseFloat(stream.duration) || parseFloat(metadata.format.duration),
              isMono: parseInt(stream.channels) === 1
            })) : [],
            // Detect mono stream combinations for stereo pairing
            monoStreamCombinations: this._detectMonoStreamCombinations(audioStreams)
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

    // Use memory-optimized software encoding settings for timecode overlay compatibility
    const hwAccelConfig = this.hwAccel;
    ffmpegArgs.push(
      '-preset', hwAccelConfig.preset.replace('-preset ', ''),
      '-tune', 'zerolatency',
      '-crf', hwAccelConfig.quality.replace('-crf ', '')
    );
    
    ffmpegArgs.push(
      '-b:v', '1000k',
      '-maxrate', hwAccelConfig.maxrate,
      '-bufsize', hwAccelConfig.bufsize,
      '-x264opts', hwAccelConfig.x264opts,
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
      '-threads', hwAccelConfig.threads.toString(),
      '-max_muxing_queue_size', '128',
      '-fflags', '+flush_packets',
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

  async generateHLSSegments(s3Key, segmentDuration = 10, options = {}) {
    try {
      // Use FFmpeg native live HLS generation
      const hlsData = await this.generateNativeLiveHLS(s3Key, segmentDuration, options);
      return hlsData;
    } catch (error) {
      console.error('Error generating native live HLS playlist:', error);
      throw error;
    }
  }



  async generateNativeLiveHLS(s3Key, segmentDuration = 10, options = {}) {
    const { showGoniometer = true, showEbuR128 = false } = options;
    const cacheKey = `nativehls:${s3Key}:${segmentDuration}:${showGoniometer ? 'gonio' : 'normal'}:${showEbuR128 ? 'r128' : 'noR128'}`;
    
    // Check if native HLS is already being generated
    if (this.activeProcesses.has(cacheKey)) {
      return this.activeProcesses.get(cacheKey);
    }
    
    // Track HLS generation in progress
    this.hlsGenerationInProgress.add(s3Key);
    
    console.log(`Starting FFmpeg native live HLS generation for ${s3Key} with ${segmentDuration}s segments${showGoniometer ? ' (with goniometer overlay)' : ''}`);
    
    const processPromise = this._generateNativeLiveHLSInternal(s3Key, segmentDuration, options);
    this.activeProcesses.set(cacheKey, processPromise);
    
    try {
      const result = await processPromise;
      return result;
    } finally {
      this.activeProcesses.delete(cacheKey);
      this.hlsGenerationInProgress.delete(s3Key);
    }
  }

  async _generateNativeLiveHLSInternal(s3Key, segmentDuration = 10, options = {}) {
    const { showGoniometer = true, showEbuR128 = false } = options;
    // Get video info for duration calculation
    const videoInfo = await this.getVideoInfo(s3Key);
    const hasAudio = videoInfo.audio !== null;
    
    // Determine if this is an MXF source file
    const isMxfSource = s3Key.toLowerCase().endsWith('.mxf');
    
    this.debugLog(`[Native Live HLS] Video duration: ${videoInfo.duration}s, audio: ${hasAudio}`);
    
    if (isMxfSource) {
      this.debugLog(`[Native Live HLS] Processing MXF file with special handling for duration and timing`);
    }
    
    // Create temporary directory for HLS output with better path sanitization
    const sanitizedKey = s3Key.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_{2,}/g, '_');
    const tempDir = path.join(this.localCacheDir, 'live-hls', sanitizedKey);
    
    // Ensure base directory exists first
    const baseDir = path.join(this.localCacheDir, 'live-hls');
    await fs.mkdir(baseDir, { recursive: true });
    
    // Clean up any existing directory for this video to start fresh
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore errors if directory doesn't exist
    }
    
    // Create the specific temp directory
    await fs.mkdir(tempDir, { recursive: true });
    this.debugLog(`[Native Live HLS] Created temp directory: ${tempDir}`);
    
    const playlistPath = path.join(tempDir, 'playlist.m3u8');
    const segmentPattern = path.join(tempDir, 'segment%03d.ts');
    const thumbnailPattern = path.join(tempDir, 'thumb%03d.jpg');
    
    // Clean up any lingering .tmp files from previous FFmpeg runs
    try {
      await fs.rm(playlistPath + '.tmp', { force: true });
      this.debugLog(`[Native Live HLS] Cleaned up existing ${playlistPath}.tmp`);
    } catch (error) {
      // Ignore errors if file doesn't exist
    }
    
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
            this.debugLog(`[Native Live HLS] Using complete cached file: ${localFilePath} (${(stats.size/1024/1024).toFixed(1)}MB)`);
          } else {
            // Partial file - use streaming mode
            inputSource = localFilePath;
            useStreamingMode = true;
            this.debugLog(`[Native Live HLS] Using streaming mode with partial file: ${localFilePath} (${(stats.size/1024/1024).toFixed(1)}MB downloading...)`);
          }
        }
      } catch (error) {
        this.warnLog(`[Native Live HLS] Local cache failed, using signed URL:`, error.message);
      }
    }
    
    if (!inputSource) {
      inputSource = s3Service.getSignedUrl(s3Key, 3600);
      this.debugLog(`[Native Live HLS] Using signed URL approach`);
    }
    
    // Final validation: if using local file, warn about potential incomplete downloads
    if (inputSource.includes(this.localCacheDir)) {
      const stats = fsSync.statSync(inputSource);
      const cacheEntry = this.localFileCache.get(s3Key);
      const expectedSize = videoInfo.size;
      const isComplete = cacheEntry?.isPartial === false;
      const sizeMatch = expectedSize ? Math.abs(stats.size - expectedSize) < 1024 : 'Unknown';
      
      this.debugLog(`[Native Live HLS] Local file validation:`);
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
      
      this.debugLog(`[Native Live HLS] Using streaming mode flags for concurrent download/processing`);
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
    
    // Video codec will be set later based on hardware acceleration capabilities
    
    // Audio encoding
    ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k');
    
    // Note: Stream mapping will be done after filter_complex to avoid conflicts
    
    // Duration control for streaming mode
    if (useStreamingMode) {
      // Use the full expected duration to prevent premature termination
      if (videoInfo.duration && videoInfo.duration > 0) {
        ffmpegArgs.push('-t', videoInfo.duration.toString());
        this.debugLog(`[Native Live HLS] Setting duration limit to ${videoInfo.duration}s for streaming mode`);
      }
    }
    
    // Use filter_complex for multiple outputs with different filters
    const sourceFps = (videoInfo && videoInfo.video && videoInfo.video.fps) ? Math.round(videoInfo.video.fps) : 25;
    console.log(`[Native Live HLS] Using source frame rate ${sourceFps}fps for SMPTE timecode`);
    
    const inputLabel = hasAudio ? '0:v:0' : '1:v:0';
    const videoInputForFilter = hasAudio ? '0:v' : '1:v';
    const thumbnailOffset = segmentDuration / 2;
    const maxThumbnails = Math.ceil(videoInfo.duration / segmentDuration);
    
    // Check for mono stream combinations first
    const hasMonoCombination = hasAudio && videoInfo.audioStreams && videoInfo.audioStreams.length > 0 && 
                              videoInfo.monoStreamCombinations && videoInfo.monoStreamCombinations.canCombineFirstTwo;

    // Complex filter graph: split input, apply different filters to each branch
    // Use setpts to reset timestamps and basic SMPTE format
    let videoFilterChain = '';
    let goniometerFilter = '';
    let stereoFilter = '';
    let ebuR128Filter = '';
    
    // Create stereo filter if needed for mono combinations
    if (hasMonoCombination) {
      const combo = videoInfo.monoStreamCombinations;
      if (showGoniometer && hasAudio) {
        // Need to split stereo output for goniometer and audio mapping
        stereoFilter = `[0:a:${combo.stream1Index}][0:a:${combo.stream2Index}]amerge=inputs=2[stereo_temp];[stereo_temp]asplit=2[stereo0][stereo_gonio]`;
      } else {
        // Only need stereo for audio mapping
        stereoFilter = `[0:a:${combo.stream1Index}][0:a:${combo.stream2Index}]amerge=inputs=2[stereo0]`;
      }
    }
    
    // Setup goniometer filter if enabled
    if (showGoniometer && hasAudio) {
      if (hasMonoCombination) {
        // Use split stereo for goniometer
        goniometerFilter = `[stereo_gonio]avectorscope=size=300x300:zoom=1.5:draw=line:rf=30:gf=30:bf=30[gonio]`;
      } else {
        // Use first audio stream for goniometer
        goniometerFilter = `[0:a]avectorscope=size=300x300:zoom=1.5:draw=line:rf=30:gf=30:bf=30[gonio]`;
      }
    }
    
    // EBU R128 is now handled separately - no video overlay needed
    
    // Build video filter chain with overlays
    if (showGoniometer && hasAudio) {
      let baseVideo = `[${videoInputForFilter}]split=2[v1][v2];[v1]setpts=PTS-STARTPTS,scale=1280:720[v1scaled]`;
      baseVideo += `;[gonio]scale=300:300[goniosized];[v1scaled][goniosized]overlay=w-w-20:h-h-50[v1final]`;
      videoFilterChain = baseVideo + `;[v1final]drawtext=text='%{pts\\:hms}':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.8:x=w-tw-10:y=h-th-10[hls]`;
    } else {
      // No overlays for videos without audio or when disabled
      videoFilterChain = `[${videoInputForFilter}]split=2[v1][v2];[v1]setpts=PTS-STARTPTS,scale=1280:720,drawtext=text='%{pts\\:hms}':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.8:x=w-tw-10:y=h-th-10[hls]`;
    }
    
    const filterComplex = [
      stereoFilter,
      goniometerFilter,
      videoFilterChain,
      `[v2]fps=1/${segmentDuration},scale=320:180[thumbs]`
    ].filter(Boolean).join(';');
    
    // Handle audio stream mappings with mono stream combination logic
    let finalFilterComplex = filterComplex;
    
    if (hasAudio && videoInfo.audioStreams && videoInfo.audioStreams.length > 0) {
      if (hasMonoCombination) {
        const combo = videoInfo.monoStreamCombinations;
        
        // Map the combined stereo stream
        ffmpegArgs.push('-map', '[stereo0]');
        
        // Add remaining mono/stereo streams after the combined pair
        let outputIndex = 1;
        videoInfo.audioStreams.forEach((stream, index) => {
          if (index !== combo.stream1Index && index !== combo.stream2Index) {
            ffmpegArgs.push('-map', `0:a:${index}`);
            outputIndex++;
          }
        });
        
        // Add metadata for combined stereo track
        ffmpegArgs.push('-metadata:s:a:0', `language=${combo.resultLanguage || 'und'}`);
        ffmpegArgs.push('-metadata:s:a:0', `title=${combo.resultTitle}`);
        
        // Add metadata for remaining tracks
        outputIndex = 1;
        videoInfo.audioStreams.forEach((stream, index) => {
          if (index !== combo.stream1Index && index !== combo.stream2Index) {
            const language = stream.language || 'und';
            const title = stream.title || `Track ${outputIndex + 1}`;
            ffmpegArgs.push('-metadata:s:a:' + outputIndex, `language=${language}`);
            ffmpegArgs.push('-metadata:s:a:' + outputIndex, `title=${title}`);
            outputIndex++;
          }
        });
      } else {
        // Standard mapping for non-mono or non-combinable streams
        videoInfo.audioStreams.forEach((stream, index) => {
          ffmpegArgs.push('-map', `0:a:${index}`);
          
          // Add metadata for each audio stream
          const language = stream.language || 'und';
          const title = stream.title || `Track ${index + 1}`;
          ffmpegArgs.push('-metadata:s:a:' + index, `language=${language}`);
          ffmpegArgs.push('-metadata:s:a:' + index, `title=${title}`);
        });
      }
    }
    
    // Add filter complex and video mapping
    ffmpegArgs.push(
      '-filter_complex', finalFilterComplex,
      '-map', '[hls]'
    );
    
    // Add hardware acceleration and video encoding settings
    const hwAccel = this.hwAccel;
    if (hwAccel.type === 'videotoolbox') {
      // Use VideoToolbox hardware acceleration on macOS
      ffmpegArgs.push(
        '-c:v', hwAccel.encoder,
        '-q:v', '23', // Use better quality setting (23 instead of 65)
        '-maxrate', '2000k',
        '-bufsize', '4000k',
        '-r', '25',
        '-pix_fmt', 'yuv420p',
        '-vsync', 'cfr',
      );
      // Remove realtime flag for complex processing
    } else if (hwAccel.type === 'nvenc') {
      // Use NVENC hardware acceleration on NVIDIA systems
      ffmpegArgs.push(
        '-c:v', hwAccel.encoder,
        '-preset', hwAccel.preset,
        '-crf', '23',
        '-maxrate', '2000k',
        '-bufsize', '4000k',
        '-r', '25',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high',
        '-level', '4.0',
        '-vsync', 'cfr',
      );
    } else {
      // Fallback to memory-optimized software encoding
      const hwAccelConfig = this.hwAccel;
      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-preset', hwAccelConfig.preset.replace('-preset ', ''),
        '-tune', 'zerolatency',
        '-crf', hwAccelConfig.quality.replace('-crf ', ''),
        '-x264opts', hwAccelConfig.x264opts,
        '-maxrate', hwAccelConfig.maxrate,
        '-bufsize', hwAccelConfig.bufsize,
        '-threads', hwAccelConfig.threads.toString(),
        '-max_muxing_queue_size', '128',
        '-fflags', '+flush_packets',
        '-r', '25',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high',
        '-level', '4.0',
        '-vsync', 'cfr',
      );
    }
    
    // Add HLS format and settings
    ffmpegArgs.push(
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
    console.log(`[Native Live HLS] Audio streams included: ${hasAudio && videoInfo.audioStreams ? videoInfo.audioStreams.length : 0} streams`);
    if (hasAudio && videoInfo.audioStreams && videoInfo.audioStreams.length > 0) {
      videoInfo.audioStreams.forEach((stream, index) => {
        console.log(`[Native Live HLS] Audio stream ${index}: ${stream.codec} ${stream.channelLayout || stream.channels + ' channels'} @ ${stream.sampleRate}Hz`);
      });
    }
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
            if (inputSource.includes(this.localCacheDir)) {
              const stats = fsSync.statSync(inputSource);
              console.error(`[Native Live HLS] Local file size: ${(stats.size/1024/1024).toFixed(1)}MB`);
            }
          }
          
          reject(new Error(`Native Live HLS generation failed: ${stderr}`));
          return;
        }
        
        try {
          // Read the playlist
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

  // Debug logging helpers
  debugLog(...args) {
    if (this.debugLogging) {
      console.log('[DEBUG]', ...args);
    }
  }

  infoLog(...args) {
    // Always log info-level messages
    console.log('[INFO]', ...args);
  }

  warnLog(...args) {
    console.warn('[WARN]', ...args);
  }

  errorLog(...args) {
    console.error('[ERROR]', ...args);
  }

  isProcessAlive(process) {
    if (!process || process.killed || process.exitCode !== null) {
      return false;
    }
    
    try {
      // Sending signal 0 to a process checks if it's alive without actually sending a signal
      return process.kill(0);
    } catch (error) {
      return false;
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


  _getChannelLayoutFromChannels(channels) {
    const channelLayouts = {
      1: 'mono',
      2: 'stereo', 
      3: '2.1',
      4: 'quad',
      5: '4.1',
      6: '5.1',
      7: '6.1',
      8: '7.1'
    };
    return channelLayouts[channels] || `${channels} channels`;
  }

  _detectMonoStreamCombinations(audioStreams) {
    if (!audioStreams || audioStreams.length < 2) {
      return null;
    }

    // Check if we have at least 2 mono streams
    const monoStreams = audioStreams.filter(stream => parseInt(stream.channels) === 1);
    
    if (monoStreams.length >= 2) {
      // Check if first two mono streams have compatible properties
      const stream1 = monoStreams[0];
      const stream2 = monoStreams[1];
      
      // They should have same sample rate and codec for best results
      const compatible = stream1.sample_rate === stream2.sample_rate && 
                        stream1.codec_name === stream2.codec_name;
      
      return {
        canCombineFirstTwo: true,
        compatible: compatible,
        stream1Index: audioStreams.findIndex(s => s === stream1),
        stream2Index: audioStreams.findIndex(s => s === stream2),
        resultTitle: `${stream1.tags?.title || 'Track 1'} + ${stream2.tags?.title || 'Track 2'} (Stereo)`,
        resultLanguage: stream1.tags?.language || stream2.tags?.language || null
      };
    }
    
    return null;
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
      // Check if existing processes are still alive before keeping them
      let hasLiveProcesses = false;
      let deadProcessesFound = false;
      
      // Check active processes
      if (this.activeProcesses) {
        for (const [cacheKey, processPromise] of this.activeProcesses.entries()) {
          if (cacheKey.includes(s3Key)) {
            // For promises we can't easily check liveness, assume they're valid if still in map
            hasLiveProcesses = true;
          }
        }
      }
      
      // Check HLS processes  
      if (this.nativeHlsCache && this.nativeHlsCache.has(s3Key)) {
        const cacheEntry = this.nativeHlsCache.get(s3Key);
        if (cacheEntry && cacheEntry.ffmpegProcess) {
          if (this.isProcessAlive(cacheEntry.ffmpegProcess)) {
            hasLiveProcesses = true;
          } else {
            deadProcessesFound = true;
            this.debugLog(`Dead FFmpeg process found for ${s3Key}, will restart`);
          }
        }
      }
      
      if (hasLiveProcesses && !deadProcessesFound) {
        this.debugLog(`Same video ${s3Key} - keeping existing live processes`);
      } else {
        console.log(`Same video ${s3Key} - found dead processes, aborting all and restarting`);
        this.abortAllFFmpegProcesses(s3Key);
      }
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
        this.debugLog(`[Segment ${segmentIndex}] Serving native HLS segment from ${segmentPath}`);
        return require('fs').createReadStream(segmentPath);
      } else {
        this.debugLog(`[Segment ${segmentIndex}] Native HLS segment not found: ${segmentPath}`);
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
          
          // For short videos, we need to be more flexible with the ready threshold
          const minSegmentsForReady = Math.min(3, Math.max(1, Math.ceil(expectedSegments / 2)));
          
          if (existingSegments >= minSegmentsForReady || existingSegments === expectedSegments) {
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

  async getAudioWaveform(s3Key, segmentDuration = 10, samples = 1000) {
    try {
      console.log(`[Waveform] Generating audio waveform for ${s3Key} with ${samples} samples`);
      
      // Get video info to determine duration and mono combinations
      const videoInfo = await this.getVideoInfo(s3Key);
      
      // Create cache key that includes mono combination info
      const hasMonoCombination = videoInfo.monoStreamCombinations && videoInfo.monoStreamCombinations.canCombineFirstTwo;
      const waveformCacheKey = `waveform:${s3Key}:${samples}:${hasMonoCombination ? 'combined' : 'standard'}`;
      
      if (!this.waveformCache) {
        this.waveformCache = new Map();
      }
      
      if (this.waveformCache.has(waveformCacheKey)) {
        console.log(`[Waveform] Returning cached waveform for ${s3Key}`);
        return this.waveformCache.get(waveformCacheKey);
      }
      
      if (!videoInfo.audio) {
        console.log(`[Waveform] No audio track found in ${s3Key}`);
        return {
          duration: videoInfo.duration,
          samples: [],
          sampleRate: 0,
          hasAudio: false
        };
      }
      
      // Generate waveform data using FFmpeg
      const waveformData = await this._generateWaveformData(s3Key, videoInfo, samples);
      
      // Cache the result
      this.waveformCache.set(waveformCacheKey, waveformData);
      
      console.log(`[Waveform] Generated waveform for ${s3Key}: ${waveformData.samples.length} samples`);
      return waveformData;
      
    } catch (error) {
      console.error(`[Waveform] Error generating waveform for ${s3Key}:`, error);
      throw error;
    }
  }

  async _generateWaveformData(s3Key, videoInfo, samples) {
    return new Promise(async (resolve, reject) => {
      let inputSource;
      const duration = videoInfo.duration;
      
      // Try to use local cached file first, otherwise fall back to signed URL
      if (this.enableLocalCache) {
        try {
          const localFilePath = await this.ensureLocalFile(s3Key);
          if (localFilePath && fsSync.existsSync(localFilePath)) {
            inputSource = localFilePath;
            console.log(`[Waveform] Using local cached file: ${localFilePath}`);
          } else {
            inputSource = s3Service.getSignedUrl(s3Key, 3600);
            console.log(`[Waveform] Local file not available, using S3 URL`);
          }
        } catch (error) {
          console.warn(`[Waveform] Error accessing local file, falling back to S3:`, error.message);
          inputSource = s3Service.getSignedUrl(s3Key, 3600);
        }
      } else {
        inputSource = s3Service.getSignedUrl(s3Key, 3600);
        console.log(`[Waveform] Local cache disabled, using S3 URL`);
      }
      
      // Calculate sample interval
      const sampleInterval = duration / samples;
      
      this.debugLog(`[Waveform] Extracting audio peaks with interval ${sampleInterval.toFixed(3)}s`);
      
      // Determine the appropriate audio filter based on audio stream layout
      let audioFilter = '[0:a]aformat=channel_layouts=stereo|mono[audio];[audio]compand,aresample=8000[out]';
      
      // For complex multi-track layouts (more than 2 mono streams), use first stream only
      const hasComplexLayout = videoInfo.audioStreams && videoInfo.audioStreams.length > 2 && 
                               videoInfo.audioStreams.filter(s => parseInt(s.channels) === 1).length > 2;
      
      if (hasComplexLayout) {
        this.debugLog(`[Waveform] Complex multi-track layout detected (${videoInfo.audioStreams.length} streams), using first audio stream only`);
        audioFilter = '[0:a:1]aformat=channel_layouts=mono[audio];[audio]compand,aresample=8000[out]';
      } else if (videoInfo.monoStreamCombinations && videoInfo.monoStreamCombinations.canCombineFirstTwo) {
        const combo = videoInfo.monoStreamCombinations;
        this.debugLog(`[Waveform] Using combined stereo from mono streams ${combo.stream1Index} and ${combo.stream2Index}`);
        
        // Use improved mono combination with explicit channel layout mapping
        // This prevents channel layout overlap warnings and handles multi-track properly
        audioFilter = `[0:a:${combo.stream1Index}]aformat=channel_layouts=mono[left];[0:a:${combo.stream2Index}]aformat=channel_layouts=mono[right];[left][right]amerge=inputs=2[merged];[merged]aformat=channel_layouts=stereo[stereo];[stereo]compand,aresample=8000[out]`;
      } else {
        this.debugLog(`[Waveform] Using standard first audio stream with channel format normalization`);
      }
      
      // Use FFmpeg to extract audio amplitude data
      const ffmpeg = spawn('ffmpeg', [
        '-i', inputSource,
        '-filter_complex', audioFilter,
        '-map', '[out]',
        '-f', 'f32le',
        '-ac', '1',
        '-'
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let audioBuffer = Buffer.alloc(0);
      let stderr = '';
      
      ffmpeg.stdout.on('data', (data) => {
        audioBuffer = Buffer.concat([audioBuffer, data]);
      });
      
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          console.error(`[Waveform] FFmpeg failed with code ${code}: ${stderr}`);
          reject(new Error(`FFmpeg waveform extraction failed: ${stderr}`));
          return;
        }
        
        try {
          // Convert raw audio data to amplitude samples
          const float32Data = new Float32Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength / 4);
          
          // Group samples and calculate RMS for each group
          const samplesPerGroup = Math.floor(float32Data.length / samples);
          const waveformSamples = [];
          
          for (let i = 0; i < samples; i++) {
            const start = i * samplesPerGroup;
            const end = Math.min(start + samplesPerGroup, float32Data.length);
            
            // Calculate RMS (Root Mean Square) for this group
            let sum = 0;
            let count = 0;
            for (let j = start; j < end; j++) {
              sum += float32Data[j] * float32Data[j];
              count++;
            }
            
            const rms = count > 0 ? Math.sqrt(sum / count) : 0;
            waveformSamples.push(Math.min(1.0, rms)); // Normalize to 0-1
          }
          
          const waveformData = {
            duration: duration,
            samples: waveformSamples,
            sampleRate: 8000,
            hasAudio: true,
            samplesPerSecond: samples / duration
          };
          
          resolve(waveformData);
          
        } catch (error) {
          console.error(`[Waveform] Error processing audio data:`, error);
          reject(error);
        }
      });
      
      ffmpeg.on('error', (error) => {
        console.error(`[Waveform] FFmpeg spawn error:`, error);
        reject(error);
      });
    });
  }

  async getEbuR128Analysis(s3Key, startTime = 0, duration = 10) {
    try {
      const videoInfo = await this.getVideoInfo(s3Key);
      const hasAudio = videoInfo.audio !== null;
      
      if (!hasAudio) {
        throw new Error('No audio streams found in video');
      }

      // Try to use local cached file first, fallback to signed URL
      let inputSource = null;
      try {
        inputSource = await this.ensureLocalFile(s3Key, duration, startTime);
        if (inputSource && require('fs').existsSync(inputSource)) {
          console.log(`[EBU R128] Using cached file: ${inputSource}`);
        } else {
          inputSource = null;
        }
      } catch (error) {
        console.warn(`[EBU R128] Failed to get cached file, using S3 URL:`, error.message);
        inputSource = null;
      }
      
      // Fallback to signed URL if no cached file
      if (!inputSource) {
        inputSource = s3Service.getSignedUrl(s3Key, 3600);
        console.log(`[EBU R128] Using S3 signed URL: ${inputSource.substring(0, 100)}...`);
      }
      
      // Determine audio input for analysis
      let audioInput = '-i';
      const hasMonoCombination = hasAudio && videoInfo.audioStreams && videoInfo.audioStreams.length > 0 && 
                                  videoInfo.monoStreamCombinations && videoInfo.monoStreamCombinations.canCombineFirstTwo;
      
      let filterComplex = '';
      if (hasMonoCombination) {
        const combo = videoInfo.monoStreamCombinations;
        // Use more robust mono combination with explicit channel mapping
        // This prevents channel layout overlap warnings by using proper channel mapping
        filterComplex = `[0:a:${combo.stream1Index}]aformat=channel_layouts=mono[left];[0:a:${combo.stream2Index}]aformat=channel_layouts=mono[right];[left][right]amerge=inputs=2[merged];[merged]aformat=channel_layouts=stereo[stereo];[stereo]ebur128=framelog=verbose:dualmono=true`;
      } else {
        // For standard audio, ensure proper channel handling and add error resilience
        filterComplex = `[0:a]aformat=channel_layouts=stereo|mono[audio];[audio]ebur128=framelog=verbose`;
      }

      const ffmpegArgs = [
        '-fflags', '+genpts+igndts',
        '-avoid_negative_ts', 'make_zero',
        '-ss', startTime.toString(),
        '-t', duration.toString(),
        '-i', inputSource,
        '-filter_complex', filterComplex,
        '-f', 'null',
        '-'
      ];

      console.log(`[EBU R128] Analyzing audio: ffmpeg ${ffmpegArgs.join(' ')}`);

      return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        let stderrOutput = '';

        ffmpeg.stderr.on('data', (data) => {
          stderrOutput += data.toString();
        });

        ffmpeg.on('close', (code) => {
          if (code !== 0) {
            console.error(`[EBU R128] FFmpeg stderr output:`, stderrOutput);
            reject(new Error(`FFmpeg process exited with code ${code}. stderr: ${stderrOutput}`));
            return;
          }

          // Parse EBU R128 measurements from stderr
          const measurements = this._parseEbuR128Output(stderrOutput);
          resolve(measurements);
        });

        ffmpeg.on('error', (error) => {
          reject(error);
        });
      });

    } catch (error) {
      console.error('Error analyzing EBU R128:', error);
      throw error;
    }
  }

  _parseEbuR128Output(output) {
    const measurements = {
      integrated: null,
      range: null,
      lraLow: null,
      lraHigh: null,
      threshold: null
    };

    console.log(`[EBU R128] Raw FFmpeg output:`, output);

    try {
      // Parse integrated loudness (format: "I:         -20.1 LUFS")
      const integratedMatch = output.match(/I:\s*(-?\d+\.?\d*)\s*LUFS/);
      if (integratedMatch) {
        measurements.integrated = parseFloat(integratedMatch[1]);
      }

      // Parse loudness range (format: "LRA:         2.3 LU")
      const rangeMatch = output.match(/LRA:\s*(\d+\.?\d*)\s*LU/);
      if (rangeMatch) {
        measurements.range = parseFloat(rangeMatch[1]);
      }

      // Parse LRA low (for additional info)
      const lraLowMatch = output.match(/LRA low:\s*(-?\d+\.?\d*)\s*LUFS/);
      if (lraLowMatch) {
        measurements.lraLow = parseFloat(lraLowMatch[1]);
      }

      // Parse LRA high (for additional info)
      const lraHighMatch = output.match(/LRA high:\s*(-?\d+\.?\d*)\s*LUFS/);
      if (lraHighMatch) {
        measurements.lraHigh = parseFloat(lraHighMatch[1]);
      }

      // Parse integrated loudness threshold
      const thresholdMatch = output.match(/Threshold:\s*(-?\d+\.?\d*)\s*LUFS/);
      if (thresholdMatch) {
        measurements.threshold = parseFloat(thresholdMatch[1]);
      }

      // Note: This format doesn't include true peak, momentary, or short-term
      // Those would require different ebur128 options or parsing frame-by-frame data

      console.log(`[EBU R128] Parsed measurements:`, measurements);
      return measurements;

    } catch (error) {
      console.error('Error parsing EBU R128 output:', error);
      return measurements;
    }
  }

}

module.exports = new VideoService();