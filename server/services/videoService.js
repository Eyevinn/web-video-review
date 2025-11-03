const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const fs = require('fs');
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
      if (!fs.existsSync(this.localCacheDir)) {
        fs.mkdirSync(this.localCacheDir, { recursive: true });
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

  async ensureLocalFile(s3Key) {
    if (!this.enableLocalCache) {
      return null;
    }

    const localPath = this.getLocalFilePath(s3Key);
    
    // Check if file already exists locally
    if (fs.existsSync(localPath)) {
      // Update access time for LRU cleanup
      const stats = fs.statSync(localPath);
      this.localFileCache.set(s3Key, {
        path: localPath,
        size: stats.size,
        lastAccessed: new Date(),
        downloadTime: this.localFileCache.get(s3Key)?.downloadTime || new Date()
      });
      
      console.log(`[Local Cache] Using cached file for ${s3Key}`);
      return localPath;
    }

    // Check if download is already in progress
    if (this.activeDownloads.has(s3Key)) {
      console.log(`[Local Cache] Waiting for ongoing download of ${s3Key}`);
      return await this.activeDownloads.get(s3Key);
    }

    // Start download
    console.log(`[Local Cache] Starting download of ${s3Key}`);
    const downloadPromise = this.downloadFileToLocal(s3Key, localPath);
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

  async downloadFileToLocal(s3Key, localPath) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      try {
        const signedUrl = s3Service.getSignedUrl(s3Key, 3600);
        const writeStream = fs.createWriteStream(localPath);
        
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

          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            writeStream.write(chunk);
          });

          response.on('end', () => {
            writeStream.end();
            
            const downloadTime = Date.now() - startTime;
            const sizeMB = (downloadedSize / 1024 / 1024).toFixed(2);
            const speedMBps = (downloadedSize / 1024 / 1024 / (downloadTime / 1000)).toFixed(2);
            
            console.log(`[Local Cache] Downloaded ${s3Key} (${sizeMB}MB) in ${downloadTime}ms (${speedMBps}MB/s)`);
            
            // Update cache tracking
            this.localFileCache.set(s3Key, {
              path: localPath,
              size: downloadedSize,
              lastAccessed: new Date(),
              downloadTime: new Date()
            });

            // Clean up cache if needed
            this.cleanupCacheIfNeeded();
            
            resolve(localPath);
          });

          response.on('error', (error) => {
            writeStream.destroy();
            fs.unlink(localPath, () => {});
            reject(error);
          });
        });

        request.on('error', (error) => {
          writeStream.destroy();
          fs.unlink(localPath, () => {});
          reject(error);
        });

        request.setTimeout(5 * 60 * 1000, () => {
          request.destroy();
          writeStream.destroy();
          fs.unlink(localPath, () => {});
          reject(new Error('Download timeout'));
        });

      } catch (error) {
        reject(error);
      }
    });
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
            fs.unlinkSync(fileInfo.path);
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
          
          resolve(info);
        });
      });
    } catch (error) {
      console.error('Error getting video info:', error);
      throw error;
    }
  }

  streamVideoChunk(s3Key, startTime = 0, duration = null) {
    const signedUrl = s3Service.getSignedUrl(s3Key, 3600);
    
    const ffmpegArgs = [
      '-i', signedUrl,
      '-ss', startTime.toString(),
      '-c:v', this.hwAccel.encoder
    ];

    // Add quality settings based on encoder type
    if (this.hwAccel.type === 'videotoolbox') {
      ffmpegArgs.push('-q:v', '65', '-realtime', '1');
    } else if (this.hwAccel.type === 'software') {
      ffmpegArgs.push('-preset', 'fast', '-crf', '23');
    }
    
    ffmpegArgs.push(
      '-b:v', '1500k',
      '-maxrate', '1500k',
      '-bufsize', '3M',
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

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    
    ffmpegProcess.stderr.on('data', (data) => {
      console.log(`FFmpeg stderr: ${data}`);
    });

    return ffmpegProcess.stdout;
  }

  generateHLSSegments(s3Key, segmentDuration = 10) {
    const signedUrl = s3Service.getSignedUrl(s3Key, 3600);
    
    return new Promise((resolve, reject) => {
      const segments = [];
      let playlistContent = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + segmentDuration + '\n';
      
      this.getVideoInfo(s3Key).then(info => {
        const totalDuration = info.duration;
        const segmentCount = Math.ceil(totalDuration / segmentDuration);
        
        for (let i = 0; i < segmentCount; i++) {
          const startTime = i * segmentDuration;
          const actualDuration = Math.min(segmentDuration, totalDuration - startTime);
          
          playlistContent += `#EXTINF:${actualDuration.toFixed(3)},\n`;
          playlistContent += `/api/video/${encodeURIComponent(s3Key)}/segment/${i}\n`;
          
          segments.push({
            index: i,
            startTime,
            duration: actualDuration,
            url: `/api/video/${encodeURIComponent(s3Key)}/segment/${i}`
          });
        }
        
        playlistContent += '#EXT-X-ENDLIST\n';
        
        resolve({
          playlist: playlistContent,
          segments,
          totalDuration,
          segmentDuration
        });
      }).catch(reject);
    });
  }

  async streamSegment(s3Key, segmentIndex, segmentDuration = 10) {
    const cacheKey = `${s3Key}:${segmentIndex}:${segmentDuration}`;
    
    // Check if segment is already cached (pre-encoded)
    if (this.segmentCache.has(cacheKey)) {
      const cached = this.segmentCache.get(cacheKey);
      console.log(`[Segment ${segmentIndex}] Serving from cache (${cached.data.length} bytes)`);
      
      // Create a readable stream from the cached buffer
      const { Readable } = require('stream');
      const stream = new Readable();
      stream.push(cached.data);
      stream.push(null);
      return stream;
    }
    
    // Pre-encode multiple segments ahead based on encoding performance
    this.preEncodeAheadSegments(s3Key, segmentIndex, segmentDuration);
    
    return this._streamSegmentInternal(s3Key, segmentIndex, segmentDuration);
  }

  async _streamSegmentInternal(s3Key, segmentIndex, segmentDuration = 10) {
    const cacheKey = `${s3Key}:${segmentIndex}:${segmentDuration}`;
    
    // Check if segment is already being processed
    if (this.activeProcesses.has(cacheKey)) {
      return this.activeProcesses.get(cacheKey);
    }
    
    const startTime = segmentIndex * segmentDuration;
    
    // Determine input source after getting video info (moved down after videoInfo is available)
    
    console.log(`[Segment ${segmentIndex}] Starting chunk creation at time ${startTime}s for ${segmentDuration}s duration`);
    console.log(`[Segment ${segmentIndex}] Video key: ${s3Key}`);
    
    // Get video info to check for audio streams - cache this per video to maintain consistency
    const videoInfoCacheKey = `videoInfo:${s3Key}`;
    let hasAudio = true;
    let videoInfo = null;
    
    if (!this.videoInfoCache) {
      this.videoInfoCache = new Map();
    }
    
    if (this.videoInfoCache.has(videoInfoCacheKey)) {
      videoInfo = this.videoInfoCache.get(videoInfoCacheKey);
      hasAudio = videoInfo.audio !== null;
    } else {
      try {
        videoInfo = await this.getVideoInfo(s3Key);
        hasAudio = videoInfo.audio !== null;
        this.videoInfoCache.set(videoInfoCacheKey, videoInfo);
        
        // Clean up video info cache after 1 hour
        setTimeout(() => {
          this.videoInfoCache.delete(videoInfoCacheKey);
        }, 60 * 60 * 1000);
      } catch (error) {
        console.log('Could not get video info, assuming audio present:', error.message);
      }
    }
    
    // Try to use local cached file for better performance, fallback to signed URL
    let inputSource = null;
    let useLocalFile = false;
    
    if (this.enableLocalCache) {
      try {
        console.log(`[Segment ${segmentIndex}] Checking for local cached file...`);
        const localFilePath = await this.ensureLocalFile(s3Key);
        if (localFilePath && require('fs').existsSync(localFilePath)) {
          inputSource = localFilePath;
          useLocalFile = true;
          console.log(`[Segment ${segmentIndex}] Using local cached file: ${localFilePath}`);
        }
      } catch (error) {
        console.log(`[Segment ${segmentIndex}] Local cache failed, falling back to signed URL:`, error.message);
      }
    }
    
    // Fallback to signed URL if local cache is disabled or failed
    if (!useLocalFile) {
      const signedUrl = s3Service.getSignedUrl(s3Key, 3600);
      inputSource = signedUrl;
      console.log(`[Segment ${segmentIndex}] Using signed URL approach`);
    }
    
    // Build FFmpeg arguments based on input source
    const ffmpegArgs = [
      '-i', inputSource,
      '-ss', startTime.toString(),
      '-t', segmentDuration.toString()
    ];
    
    // Handle audio configuration for consistent HLS stream structure
    if (hasAudio) {
      // Normal video with audio
      ffmpegArgs.push(
        '-map', '0:v:0',
        '-map', '0:a:0'
      );
    } else {
      // Video-only source: add silent audio for HLS consistency
      ffmpegArgs.push(
        '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest'
      );
    }
    
    // Video encoding with hardware acceleration
    ffmpegArgs.push('-c:v', this.hwAccel.encoder);
    
    // Add quality settings based on encoder type - optimized for speed
    if (this.hwAccel.type === 'videotoolbox') {
      ffmpegArgs.push(
        '-q:v', '70', // Slightly lower quality for faster encoding
        '-realtime', '1', // Enable real-time encoding for better performance
        '-allow_sw', '1' // Allow software fallback if needed
      );
    } else if (this.hwAccel.type === 'software') {
      ffmpegArgs.push(
        '-preset', 'ultrafast', // Fastest possible encoding
        '-crf', '28', // Lower quality for speed
        '-tune', 'zerolatency' // Optimize for low latency
      );
    }
    
    // Common video settings
    ffmpegArgs.push(
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-g', Math.floor(segmentDuration * 2), // GOP size aligned to segment duration
      '-keyint_min', Math.floor(segmentDuration * 2),
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${segmentDuration})`,
      '-r', '25',
      '-s', '1280x720',
      '-pix_fmt', 'yuv420p', // Force 4:2:0 for HLS compatibility
      '-profile:v', 'high',
      '-level', '4.0'
    );
    
    // Audio encoding (always present now)
    ffmpegArgs.push(
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ac', '2',
      '-ar', '44100'
    );
    
    ffmpegArgs.push(
      '-bsf:v', 'h264_mp4toannexb',
      '-f', 'mpegts',
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
      '-muxrate', '2500k',
      '-pcr_period', '60',
      '-pat_period', '0.1',
      '-sdt_period', '0.5',
      '-threads', '0',
      'pipe:1'
    );

    console.log(`[Segment ${segmentIndex}] Using ${this.hwAccel.type} acceleration with ${this.hwAccel.encoder}`);
    console.log(`[Segment ${segmentIndex}] Audio detected: ${hasAudio} ${hasAudio ? '(using original audio)' : '(adding silent audio for HLS consistency)'}`);

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    
    // Store active process
    this.activeProcesses.set(cacheKey, ffmpegProcess.stdout);
    
    ffmpegProcess.stderr.on('data', (data) => {
      const message = data.toString();
      
      // Log all progress and error information for debugging
      if (message.includes('frame=') || message.includes('time=') || message.includes('speed=')) {
        // Progress information
        console.log(`[Segment ${segmentIndex}] FFmpeg progress: ${message.trim()}`);
      } else if (message.includes('error') || message.includes('Error')) {
        // Error messages
        console.log(`[Segment ${segmentIndex}] FFmpeg error: ${message.trim()}`);
      } else if (message.includes('Stream mapping:') || message.includes('Input #') || message.includes('Output #')) {
        // Stream information
        console.log(`[Segment ${segmentIndex}] FFmpeg info: ${message.trim()}`);
      }
    });

    ffmpegProcess.on('close', (code) => {
      // Clean up active process
      this.activeProcesses.delete(cacheKey);
      console.log(`[Segment ${segmentIndex}] FFmpeg process completed with exit code: ${code}`);
    });

    return ffmpegProcess.stdout;
  }
  

  async preEncodeAheadSegments(s3Key, currentSegmentIndex, segmentDuration) {
    try {
      // Get video info to check total segments
      const videoInfo = await this.getVideoInfo(s3Key);
      const totalSegments = Math.ceil(videoInfo.duration / segmentDuration);
      
      // Determine how many segments to pre-encode based on past performance
      const encodingPerformanceKey = `perf:${s3Key}`;
      let segmentsAhead = 3; // Default: pre-encode 3 segments ahead
      
      if (this.encodingTimes.has(encodingPerformanceKey)) {
        const avgTime = this.encodingTimes.get(encodingPerformanceKey);
        // If encoding takes longer than segment duration, pre-encode more segments
        if (avgTime > segmentDuration * 1000) {
          segmentsAhead = Math.min(6, Math.ceil(avgTime / (segmentDuration * 1000)) + 2);
        }
      }
      
      console.log(`[Pre-encode] Planning to pre-encode ${segmentsAhead} segments ahead for ${s3Key}`);
      
      // Create a list of segments to pre-encode in order
      const segmentsToEncode = [];
      
      // Always prioritize segment 0 if it's not already processed
      const segment0CacheKey = `${s3Key}:0:${segmentDuration}`;
      if (!this.activeProcesses.has(segment0CacheKey) && !this.segmentCache.has(segment0CacheKey)) {
        segmentsToEncode.push(0);
      }
      
      // Then add segments sequentially starting from the current segment + 1
      for (let i = 1; i <= segmentsAhead; i++) {
        const nextSegmentIndex = currentSegmentIndex + i;
        
        // Don't pre-encode if we're at or past the last segment
        if (nextSegmentIndex >= totalSegments) {
          break;
        }
        
        const nextCacheKey = `${s3Key}:${nextSegmentIndex}:${segmentDuration}`;
        
        // Don't pre-encode if already being processed or exists
        if (this.activeProcesses.has(nextCacheKey) || this.segmentCache.has(nextCacheKey)) {
          continue;
        }
        
        // Don't add segment 0 again if it's already in the list
        if (nextSegmentIndex !== 0) {
          segmentsToEncode.push(nextSegmentIndex);
        }
      }
      
      // Start encoding segments in the determined order
      for (const segmentIndex of segmentsToEncode) {
        console.log(`[Pre-encode] Starting background encoding of segment ${segmentIndex}`);
        
        // Start encoding in the background (don't await)
        this.encodeAndCacheSegment(s3Key, segmentIndex, segmentDuration);
      }
        
    } catch (error) {
      console.error(`[Pre-encode] Error in preEncodeAheadSegments:`, error);
    }
  }

  async encodeAndCacheSegment(s3Key, segmentIndex, segmentDuration) {
    const cacheKey = `${s3Key}:${segmentIndex}:${segmentDuration}`;
    const startTime = Date.now();
    
    try {
      const stream = await this._streamSegmentInternal(s3Key, segmentIndex, segmentDuration);
      
      // Consume the stream to cache the segment
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const segmentData = Buffer.concat(chunks);
        this.segmentCache.set(cacheKey, {
          data: segmentData,
          cached: Date.now()
        });
        
        // Track encoding performance
        const encodingTime = Date.now() - startTime;
        const perfKey = `perf:${s3Key}`;
        if (this.encodingTimes.has(perfKey)) {
          const prevTime = this.encodingTimes.get(perfKey);
          this.encodingTimes.set(perfKey, (prevTime + encodingTime) / 2); // Running average
        } else {
          this.encodingTimes.set(perfKey, encodingTime);
        }
        
        console.log(`[Pre-encode] Segment ${segmentIndex} cached (${segmentData.length} bytes) in ${encodingTime}ms`);
        
        // Clean up old cache entries
        setTimeout(() => {
          this.segmentCache.delete(cacheKey);
        }, this.cacheExpiry);
      });
      stream.on('error', err => {
        console.error(`[Pre-encode] Error caching segment ${segmentIndex}:`, err);
      });
      
    } catch (error) {
      console.error(`[Pre-encode] Error encoding segment ${segmentIndex}:`, error);
    }
  }

  async generateSegmentThumbnail(s3Key, segmentIndex, segmentDuration, startTime) {
    const thumbnailKey = `${s3Key}:${segmentIndex}:${segmentDuration}`;
    
    // Check if thumbnail already exists in cache
    if (this.thumbnailCache.has(thumbnailKey)) {
      return this.thumbnailCache.get(thumbnailKey);
    }
    
    try {
      const signedUrl = s3Service.getSignedUrl(s3Key, 3600);
      // Generate thumbnail at the middle of the segment for better representation
      const thumbnailTime = startTime + (segmentDuration / 2);
      const thumbnailBase64 = await this.extractThumbnailAtTime(signedUrl, thumbnailTime);
      
      const thumbnailData = {
        segmentIndex,
        time: thumbnailTime,
        data: thumbnailBase64,
        cached: Date.now()
      };
      
      // Cache the thumbnail
      this.thumbnailCache.set(thumbnailKey, thumbnailData);
      
      // Clean up old cache entries
      setTimeout(() => {
        this.thumbnailCache.delete(thumbnailKey);
      }, this.cacheExpiry);
      
      return thumbnailData;
    } catch (error) {
      console.error(`Error generating thumbnail for segment ${segmentIndex}:`, error);
      return null;
    }
  }

  async getSegmentThumbnails(s3Key, segmentDuration = 10) {
    try {
      const info = await this.getVideoInfo(s3Key);
      const segmentCount = Math.ceil(info.duration / segmentDuration);
      const thumbnails = [];
      
      for (let i = 0; i < segmentCount; i++) {
        const thumbnailKey = `${s3Key}:${i}:${segmentDuration}`;
        if (this.thumbnailCache.has(thumbnailKey)) {
          thumbnails.push(this.thumbnailCache.get(thumbnailKey));
        } else {
          // Return placeholder for segments that haven't been loaded yet
          thumbnails.push({
            segmentIndex: i,
            time: i * segmentDuration + (segmentDuration / 2),
            data: null,
            cached: null
          });
        }
      }
      
      return thumbnails;
    } catch (error) {
      console.error('Error getting segment thumbnails:', error);
      throw error;
    }
  }

  async extractThumbnails(s3Key, count = 10) {
    try {
      const info = await this.getVideoInfo(s3Key);
      const interval = info.duration / count;
      const signedUrl = s3Service.getSignedUrl(s3Key, 3600);
      
      const thumbnails = [];
      
      for (let i = 0; i < count; i++) {
        const time = i * interval;
        const thumbnail = await this.extractThumbnailAtTime(signedUrl, time);
        thumbnails.push({
          time,
          data: thumbnail
        });
      }
      
      return thumbnails;
    } catch (error) {
      console.error('Error extracting thumbnails:', error);
      throw error;
    }
  }

  extractThumbnailAtTime(signedUrl, time) {
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-i', signedUrl,
        '-ss', time.toString(),
        '-vframes', '1',
        '-f', 'image2',
        '-update', '1',
        '-vcodec', 'png',
        'pipe:1'
      ];

      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      const chunks = [];

      ffmpegProcess.stdout.on('data', (chunk) => {
        chunks.push(chunk);
      });

      ffmpegProcess.stdout.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString('base64'));
      });

      ffmpegProcess.stderr.on('data', (data) => {
        console.log(`Thumbnail FFmpeg stderr: ${data}`);
      });

      ffmpegProcess.on('error', reject);
    });
  }
}

module.exports = new VideoService();