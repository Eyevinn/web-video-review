const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const videoRoutes = require('./routes/video');
const s3Routes = require('./routes/s3');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/video', videoRoutes);
app.use('/api/s3', s3Routes);

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/build')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`S3 Endpoint: ${process.env.S3_ENDPOINT}`);
  console.log(`S3 Bucket: ${process.env.S3_BUCKET}`);
});