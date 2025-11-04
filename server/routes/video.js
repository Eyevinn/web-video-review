const express = require('express');
const router = express.Router();
const videoService = require('../services/videoService');
const path = require('path');
const fs = require('fs');

async function waitForInitialSegments(tempDir, minSegments = 2, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const checkSegments = () => {
      try {
        let segmentCount = 0;
        for (let i = 0; i < minSegments; i++) {
          const segmentPath = path.join(tempDir, `segment${i.toString().padStart(3, '0')}.ts`);
          if (fs.existsSync(segmentPath)) {
            segmentCount++;
          }
        }
        
        if (segmentCount >= minSegments) {
          console.log(`Found ${segmentCount} initial segments, ready to serve playlist`);
          resolve();
          return;
        }
        
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeoutMs) {
          console.log(`Timeout waiting for segments after ${elapsed}ms, serving playlist anyway`);
          resolve();
          return;
        }
        
        setTimeout(checkSegments, 100);
      } catch (error) {
        console.warn('Error checking for segments:', error);
        resolve();
      }
    };
    
    checkSegments();
  });
}

router.get('/:key/info', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    
    // Abort any existing FFmpeg processes and load new video
    await videoService.loadNewVideo(key);
    
    // Get video info
    const videoInfo = await videoService.getVideoInfo(key);
    
    res.json(videoInfo);
  } catch (error) {
    console.error('Error getting video info:', error);
    
    if (error.code === 'InvalidAccessKeyId') {
      res.status(401).json({ 
        error: 'Invalid S3 credentials for video access.',
        code: 'INVALID_CREDENTIALS'
      });
    } else {
      res.status(500).json({ 
        error: 'Failed to get video information: ' + error.message,
        code: 'VIDEO_INFO_ERROR'
      });
    }
  }
});

router.get('/:key/stream', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const { t: startTime = 0, d: duration } = req.query;
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    
    const videoStream = await videoService.streamVideoChunk(key, parseFloat(startTime), duration ? parseFloat(duration) : null);
    
    videoStream.on('error', (error) => {
      console.error('Video stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Video streaming failed' });
      }
    });
    
    videoStream.pipe(res);
    
  } catch (error) {
    console.error('Error streaming video:', error);
    res.status(500).json({ error: 'Failed to stream video' });
  }
});

router.get('/:key/playlist.m3u8', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const { segmentDuration = 10 } = req.query;
    
    // Check if we have existing HLS cache
    let playlist;
    let cacheEntry = null;
    
    if (videoService.nativeHlsCache && videoService.nativeHlsCache.has(key)) {
      cacheEntry = videoService.nativeHlsCache.get(key);
      const playlistPath = path.join(cacheEntry.tempDir, 'playlist.m3u8');
      
      if (require('fs').existsSync(playlistPath)) {
        // Wait for at least 2 segments before serving the playlist
        await waitForInitialSegments(cacheEntry.tempDir, 2, 30000);
        
        // Read the updated playlist after waiting for segments
        playlist = require('fs').readFileSync(playlistPath, 'utf8');
        console.log(`Serving updated playlist for ${key} from ${playlistPath}`);
      }
    }
    
    if (!playlist) {
      // Generate initial HLS data and wait for initial segments
      const hlsData = await videoService.generateHLSSegments(key, parseInt(segmentDuration));
      playlist = hlsData.playlist;
      
      // Wait for initial segments to be created before returning playlist
      const newCacheEntry = videoService.nativeHlsCache && videoService.nativeHlsCache.get(key);
      if (newCacheEntry) {
        await waitForInitialSegments(newCacheEntry.tempDir, 2, 30000); // Wait for 2 segments, max 30 seconds
        
        // Read the updated playlist after segments are available
        const playlistPath = path.join(newCacheEntry.tempDir, 'playlist.m3u8');
        if (require('fs').existsSync(playlistPath)) {
          playlist = require('fs').readFileSync(playlistPath, 'utf8');
          console.log(`Serving initial playlist for ${key} with segments available`);
        }
      }
    }
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(playlist);
    
  } catch (error) {
    console.error('Error generating HLS playlist:', error);
    res.status(500).json({ error: 'Failed to generate HLS playlist' });
  }
});

// Route for native HLS segment files (e.g., segment000.ts, segment001.ts)
router.get('/:key/segment:segmentFile', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const segmentFile = req.params.segmentFile; // e.g., "000.ts"
    // Extract segment index from filename (e.g., "000.ts" -> 0)
    const match = segmentFile.match(/(\d+)\.ts$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid segment filename format' });
    }
    
    const segmentIndex = parseInt(match[1]);
    const { segmentDuration = 10 } = req.query;
    
    console.log(`[Route] Serving native HLS segment: ${key}/segment${segmentFile} (index: ${segmentIndex})`);
    
    // Optimized headers for streaming
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Accept-Ranges', 'bytes');
    
    const segmentStream = await videoService.streamSegment(key, segmentIndex, parseInt(segmentDuration));
    
    // Handle client disconnect
    req.on('close', () => {
      if (segmentStream && !segmentStream.destroyed) {
        segmentStream.destroy();
      }
    });
    
    segmentStream.on('error', (error) => {
      console.error('Segment stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Segment streaming failed' });
      }
    });
    
    segmentStream.pipe(res);
    
  } catch (error) {
    console.error('Error streaming segment:', error);
    res.status(500).json({ error: 'Failed to stream segment' });
  }
});

router.get('/:key/segment/:index', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const segmentIndex = parseInt(req.params.index);
    const { segmentDuration = 10 } = req.query;
    
    // Optimized headers for streaming
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Accept-Ranges', 'bytes');
    
    const segmentStream = await videoService.streamSegment(key, segmentIndex, parseInt(segmentDuration));
    
    // Handle client disconnect
    req.on('close', () => {
      if (segmentStream && !segmentStream.destroyed) {
        segmentStream.destroy();
      }
    });
    
    segmentStream.on('error', (error) => {
      console.error('Segment stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Segment streaming failed' });
      }
    });
    
    segmentStream.pipe(res);
    
  } catch (error) {
    console.error('Error streaming segment:', error);
    res.status(500).json({ error: 'Failed to stream segment' });
  }
});

router.get('/:key/thumbnails', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const { segmentDuration = 10 } = req.query;
    
    const thumbnails = await videoService.getSegmentThumbnails(key, parseInt(segmentDuration));
    res.json(thumbnails);
    
  } catch (error) {
    console.error('Error getting segment thumbnails:', error);
    res.status(500).json({ error: 'Failed to get segment thumbnails' });
  }
});

router.get('/:key/waveform', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const { segmentDuration = 10, samples = 1000 } = req.query;
    
    const waveform = await videoService.getAudioWaveform(key, parseInt(segmentDuration), parseInt(samples));
    res.json(waveform);
    
  } catch (error) {
    console.error('Error getting audio waveform:', error);
    res.status(500).json({ error: 'Failed to get audio waveform' });
  }
});

// Route for individual thumbnail files (e.g., thumb000.jpg, thumb001.jpg)
router.get('/:key/thumb:thumbFile', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const thumbFile = req.params.thumbFile; // e.g., "000.jpg"
    
    // Extract thumbnail index from filename (e.g., "000.jpg" -> 0)
    const match = thumbFile.match(/(\d+)\.jpg$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid thumbnail filename format' });
    }
    
    const thumbIndex = parseInt(match[1]);
    
    // Check if we have native HLS cache with thumbnails
    if (videoService.nativeHlsCache && videoService.nativeHlsCache.has(key)) {
      const hlsCacheEntry = videoService.nativeHlsCache.get(key);
      const thumbnailPath = path.join(hlsCacheEntry.tempDir, `thumb${thumbIndex.toString().padStart(3, '0')}.jpg`);
      
      if (fs.existsSync(thumbnailPath)) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        console.log(`[Route] Serving native HLS thumbnail: ${key}/thumb${thumbFile}`);
        return fs.createReadStream(thumbnailPath).pipe(res);
      }
    }
    
    // Fallback: thumbnail not found
    res.status(404).json({ error: 'Thumbnail not found' });
    
  } catch (error) {
    console.error('Error serving thumbnail:', error);
    res.status(500).json({ error: 'Failed to serve thumbnail' });
  }
});

router.get('/:key/thumbnail', async (req, res) => {
  // Legacy single thumbnail endpoint - now redirects to thumbnails list
  try {
    const key = decodeURIComponent(req.params.key);
    const { segmentDuration = 10 } = req.query;
    
    const thumbnails = await videoService.getSegmentThumbnails(key, parseInt(segmentDuration));
    
    // Return the first available thumbnail or a 404
    const firstThumbnail = thumbnails.find(t => t.data !== null);
    if (firstThumbnail) {
      res.json(firstThumbnail);
    } else {
      res.status(404).json({ error: 'No thumbnails available yet' });
    }
    
  } catch (error) {
    console.error('Error getting thumbnail:', error);
    res.status(500).json({ error: 'Failed to get thumbnail' });
  }
});

router.get('/:key/progress', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const progress = await videoService.getVideoProgress(key);
    res.json(progress);
  } catch (error) {
    console.error('Error getting video progress:', error);
    res.status(500).json({ error: 'Failed to get video progress' });
  }
});

router.get('/:key/seek', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const { t: seekTime = 0, d: duration = 30 } = req.query;
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    
    const videoStream = await videoService.streamVideoChunk(key, parseFloat(seekTime), parseFloat(duration));
    
    videoStream.on('error', (error) => {
      console.error('Seek stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Seek streaming failed' });
      }
    });
    
    videoStream.pipe(res);
    
  } catch (error) {
    console.error('Error seeking video:', error);
    res.status(500).json({ error: 'Failed to seek video' });
  }
});

// Global abort endpoint for troubleshooting
router.post('/abort-all', async (req, res) => {
  try {
    const abortedCount = videoService.abortAllFFmpegProcesses();
    res.json({ 
      message: 'All FFmpeg processes aborted',
      abortedCount,
      success: true
    });
  } catch (error) {
    console.error('Error aborting FFmpeg processes:', error);
    res.status(500).json({ error: 'Failed to abort FFmpeg processes' });
  }
});

// Video-specific abort endpoint
router.post('/:key/abort', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const abortedCount = videoService.abortAllFFmpegProcesses(key);
    res.json({ 
      message: `FFmpeg processes aborted for ${key}`,
      abortedCount,
      videoKey: key,
      success: true
    });
  } catch (error) {
    console.error('Error aborting FFmpeg processes for video:', error);
    res.status(500).json({ error: 'Failed to abort FFmpeg processes for video' });
  }
});

module.exports = router;