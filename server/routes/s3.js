const express = require('express');
const router = express.Router();
const s3Service = require('../services/s3Service');

router.get('/videos', async (req, res) => {
  try {
    const { prefix, search, fileType, minSize, maxSize, dateFrom, dateTo, sortBy, sortOrder } = req.query;
    
    // Parse numeric values
    const filters = {
      search,
      fileType,
      minSize: minSize ? parseInt(minSize) : 0,
      maxSize: maxSize ? parseInt(maxSize) : Number.MAX_SAFE_INTEGER,
      dateFrom,
      dateTo,
      sortBy: sortBy || 'name',
      sortOrder: sortOrder || 'asc'
    };
    
    console.log(`[S3 Route] Fetching videos with filters:`, { prefix, ...filters });
    
    const videos = await s3Service.listVideos(prefix, filters);
    res.json(videos);
  } catch (error) {
    console.error('Error fetching videos:', error);
    
    if (error.code === 'InvalidAccessKeyId') {
      res.status(401).json({ 
        error: 'Invalid S3 credentials. Please check your S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in .env file.',
        code: 'INVALID_CREDENTIALS'
      });
    } else if (error.code === 'NoSuchBucket') {
      res.status(404).json({ 
        error: 'S3 bucket not found. Please check your S3_BUCKET in .env file.',
        code: 'BUCKET_NOT_FOUND'
      });
    } else {
      res.status(500).json({ 
        error: 'Failed to fetch videos from S3: ' + error.message,
        code: 'S3_ERROR'
      });
    }
  }
});

router.get('/video/:key/metadata', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const metadata = await s3Service.getVideoMetadata(key);
    res.json(metadata);
  } catch (error) {
    console.error('Error fetching video metadata:', error);
    res.status(500).json({ error: 'Failed to fetch video metadata' });
  }
});

router.get('/video/:key/url', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const { expires = 3600 } = req.query;
    const signedUrl = s3Service.getSignedUrl(key, parseInt(expires));
    res.json({ url: signedUrl });
  } catch (error) {
    console.error('Error generating signed URL:', error);
    res.status(500).json({ error: 'Failed to generate signed URL' });
  }
});

module.exports = router;