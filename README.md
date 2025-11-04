# Web Video Review

A professional web application for reviewing broadcast video files stored in S3-compatible buckets. Features real-time video streaming with FFmpeg-powered transcoding and timeline navigation with seek functionality.

## Features

- **S3 Integration**: Connect to any S3-compatible storage (AWS S3, MinIO, etc.)
- **Real-time Transcoding**: FFmpeg-powered conversion to web-friendly formats
- **Timeline Navigation**: Visual timeline with thumbnail previews
- **Seek Functionality**: Jump to any point in the video instantly
- **Broadcast Format Support**: Handles large broadcast formats (MXF, TS, M2TS, etc.)
- **Responsive Design**: Professional interface optimized for video review

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

## Prerequisites

- Node.js 16+ and npm
- FFmpeg installed and accessible in PATH
- S3-compatible storage with video files
- S3 access credentials

## Installation

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
   
   Edit `.env` with your S3 configuration:
   ```env
   # For AWS S3
   S3_ENDPOINT=https://s3.amazonaws.com
   S3_BUCKET=your-video-bucket
   S3_ACCESS_KEY_ID=your-access-key
   S3_SECRET_ACCESS_KEY=your-secret-key
   S3_REGION=us-east-1
   # AWS_SESSION_TOKEN=your-session-token  # Optional: for temporary credentials/IAM roles
   
   # For MinIO or other S3-compatible storage
   # S3_ENDPOINT=https://your-minio-endpoint.com
   # S3_BUCKET=your-bucket-name
   # S3_ACCESS_KEY_ID=your-minio-access-key
   # S3_SECRET_ACCESS_KEY=your-minio-secret-key
   # S3_REGION=us-east-1
   
   PORT=3001
   FFMPEG_PATH=/usr/local/bin/ffmpeg
   CHUNK_DURATION=10
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

### Video Routes
- `GET /api/video/:key/info` - Get detailed video information
- `GET /api/video/:key/stream` - Stream video with optional start time
- `GET /api/video/:key/seek` - Seek to specific time and stream chunk
- `GET /api/video/:key/playlist.m3u8` - HLS playlist for streaming
- `GET /api/video/:key/segment/:index` - Individual HLS segments
- `GET /api/video/:key/thumbnails` - Extract timeline thumbnails
- `GET /api/video/:key/thumbnail` - Get thumbnail at specific time

## Supported Video Formats

- MP4, MOV, AVI, MKV
- MXF (broadcast format)
- MPEG-TS, M2TS
- And many more via FFmpeg

## Configuration Options

### Environment Variables

- `S3_ENDPOINT` - S3 endpoint URL
- `S3_BUCKET` - S3 bucket name
- `S3_ACCESS_KEY_ID` - S3 access key
- `S3_SECRET_ACCESS_KEY` - S3 secret key
- `S3_REGION` - S3 region
- `AWS_SESSION_TOKEN` - Optional: Session token for temporary credentials or IAM roles
- `PORT` - Server port (default: 3001)
- `FFMPEG_PATH` - Path to FFmpeg binary
- `CHUNK_DURATION` - HLS segment duration in seconds

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