# Web Video Review

A professional web application for reviewing broadcast video files stored in S3-compatible buckets. Features real-time video streaming with FFmpeg-powered transcoding, timeline navigation, and comprehensive video analysis tools.

![Web Video Review Interface](screenshot1.png)

## Features

- **S3 Integration**: Connect to any S3-compatible storage (AWS S3, MinIO, etc.)
- **HLS Streaming**: Live HTTP Live Streaming with adaptive segmentation and progressive playlist updates
- **Video Analysis Tools**: 
  - EBU R128 loudness measurement and real-time monitoring
  - Audio waveform visualization with configurable sample rates
  - Video thumbnails and frame previews
  - Multi-track audio support (up to 8+ separate mono tracks)
- **Timeline Navigation**: Visual timeline with thumbnail previews and seek functionality
- **Progressive Download**: Smart caching with partial file support for large video files
- **Hardware Acceleration**: VideoToolbox acceleration on macOS for optimal performance
- **Broadcast Format Support**: Handles large broadcast formats (MXF, TS, M2TS, etc.)
- **Responsive Design**: Independent video player and file list layouts
- **Docker Support**: Single container architecture with easy deployment

![Video Analysis Tools](screenshot2.png)

## Architecture

### Backend (Node.js)
- Express.js API server
- S3-compatible storage integration
- FFmpeg-based video processing
- HLS streaming with chunking
- Real-time thumbnail generation

### Frontend (React)
- Video player with custom controls
- Timeline with thumbnail scrubbing
- File browser for S3 contents
- Responsive video review interface

## Quick Start with Docker

The easiest way to get started is using Docker:

```bash
# Clone the repository
git clone https://github.com/eyevinn/web-video-review.git
cd web-video-review

# Set up environment variables
cp .env.example .env
# Edit .env with your AWS credentials and S3 bucket

# Run with Docker Compose
docker-compose up
```

The application will be available at `http://localhost:3001`.

## Manual Installation

### Prerequisites

- Node.js 18+ and npm
- FFmpeg installed and accessible in PATH
- S3-compatible storage with video files
- S3 access credentials

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd web-video-review
   ```

2. **Install dependencies**
   ```bash
   npm run install:all
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` with your configuration:
   ```env
   # AWS S3 Configuration
   AWS_ACCESS_KEY_ID=your-access-key
   AWS_SECRET_ACCESS_KEY=your-secret-key
   AWS_REGION=us-east-1
   S3_BUCKET=your-video-bucket
   
   # Application Settings
   PORT=3001
   LOCAL_CACHE_DIR=/tmp/videoreview
   MAX_LOCAL_CACHE_SIZE=10737418240
   ENABLE_LOCAL_CACHE=true
   DEBUG=false
   ```
   
   **Important:** Make sure your S3 credentials have the following permissions:
   - `s3:ListBucket` - To list video files
   - `s3:GetObject` - To read and stream video files
   - `s3:GetObjectMetadata` - To get file information

4. **Start the application**
   ```bash
   npm run dev
   ```

   This starts both the backend server (port 3001) and frontend development server (port 3000).

## Production Deployment

1. **Build the frontend**
   ```bash
   npm run build
   ```

2. **Start production server**
   ```bash
   npm start
   ```

## API Endpoints

### S3 Routes
- `GET /api/s3/videos` - List video files in bucket
- `GET /api/s3/video/:key/metadata` - Get video file metadata
- `GET /api/s3/video/:key/url` - Generate signed URL

### Video Operations
- `GET /api/video/:key/info` - Get video metadata
- `GET /api/video/:key/playlist.m3u8` - HLS playlist generation
- `GET /api/video/:key/segment:id` - HLS segment streaming
- `GET /api/video/:key/stream` - Direct video streaming
- `GET /api/video/:key/seek` - Time-based seeking

### Analysis Tools
- `GET /api/video/:key/waveform` - Audio waveform data
- `GET /api/video/:key/ebu-r128` - EBU R128 loudness analysis
- `GET /api/video/:key/thumbnails` - Video thumbnail generation
- `GET /api/video/:key/progress` - Download/processing progress

### Management
- `POST /api/video/abort-all` - Abort all FFmpeg processes
- `POST /api/video/:key/abort` - Abort processes for specific video

## Supported Video Formats

- MP4, MOV, AVI, MKV
- MXF (broadcast format)
- MPEG-TS, M2TS
- And many more via FFmpeg

## Configuration Options

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Application port | 3001 |
| `AWS_ACCESS_KEY_ID` | AWS access key | Required |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | Required |
| `AWS_REGION` | AWS region | us-east-1 |
| `S3_BUCKET` | S3 bucket name | Required |
| `LOCAL_CACHE_DIR` | Local cache directory | /tmp/videoreview |
| `MAX_LOCAL_CACHE_SIZE` | Cache size limit (bytes) | 10GB |
| `ENABLE_LOCAL_CACHE` | Enable local caching | true |
| `DEBUG` | Enable debug logging | false |

### FFmpeg Requirements

Ensure FFmpeg is installed with the following codecs:
- libx264 (H.264 encoding)
- aac (AAC audio encoding)
- Various input format support

## Usage

1. **Access the application** at `http://localhost:3000`
2. **Browse videos** in the left sidebar
3. **Select a video** to start reviewing
4. **Use timeline controls** to navigate:
   - Click anywhere on timeline to seek
   - Use +/- buttons for frame-accurate navigation
   - Enter specific time in MM:SS format
5. **Video controls** include play/pause, volume, and format information

## Performance Considerations

- Videos are transcoded on-demand for optimal streaming
- Thumbnails are generated dynamically and cached
- HLS segments provide efficient streaming of large files
- Seeking uses FFmpeg's fast seek capabilities

## Troubleshooting

### Common Issues

1. **"Invalid S3 credentials" error**
   - Verify your `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are correct
   - For MinIO: Ensure the access key exists and has the correct permissions
   - For AWS S3: Check that the IAM user has the required S3 permissions

2. **"S3 bucket not found" error**
   - Verify the `S3_BUCKET` name is correct and exists
   - Check that your credentials have access to the specified bucket

3. **FFmpeg not found**
   - Ensure FFmpeg is installed and in PATH
   - Set `FFMPEG_PATH` environment variable if needed
   - Install FFmpeg: `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Ubuntu)

4. **S3 connection errors**
   - Verify S3 endpoint URL is correct (especially for MinIO)
   - Check network connectivity to your S3 endpoint
   - For MinIO: Ensure the endpoint is accessible and SSL certificate is valid

5. **Video won't play**
   - Ensure browser supports HLS or MP4
   - Check that video files exist in the S3 bucket
   - Verify FFmpeg can access and process the video files

6. **404 errors on API calls**
   - Make sure the backend server is running on port 3001
   - Check that the frontend is configured to proxy requests to the backend
   - Verify your `.env` file is in the project root directory

### Logs

Backend logs include:
- S3 operation results
- FFmpeg processing output
- Streaming session information

## License

MIT