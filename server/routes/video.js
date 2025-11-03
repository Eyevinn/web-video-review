const express = require('express');
const router = express.Router();
const videoService = require('../services/videoService');
const rangeParser = require('range-parser');

router.get('/:key/info', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const info = await videoService.getVideoInfo(key);
    res.json(info);
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
    
    const videoStream = videoService.streamVideoChunk(key, parseFloat(startTime), duration ? parseFloat(duration) : null);
    
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
    
    const hlsData = await videoService.generateHLSSegments(key, parseInt(segmentDuration));
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(hlsData.playlist);
    
  } catch (error) {
    console.error('Error generating HLS playlist:', error);
    res.status(500).json({ error: 'Failed to generate HLS playlist' });
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

router.get('/:key/thumbnail', async (req, res) => {
  // Thumbnail generation disabled for performance
  res.status(501).json({ error: 'Thumbnail generation disabled' });
});

router.get('/:key/seek', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const { t: seekTime = 0, d: duration = 30 } = req.query;
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    
    const videoStream = videoService.streamVideoChunk(key, parseFloat(seekTime), parseFloat(duration));
    
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

module.exports = router;