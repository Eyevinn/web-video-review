import React from 'react';

function VideoList({ videos, selectedVideo, onVideoSelect, onRefresh }) {
  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString();
  };

  return (
    <div className="video-list">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h3>Video Files</h3>
        <button className="btn" onClick={onRefresh} style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}>
          Refresh
        </button>
      </div>
      
      {videos.length === 0 ? (
        <div style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>
          <div>No video files found</div>
          <div style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
            Make sure your S3 credentials are configured correctly
          </div>
        </div>
      ) : (
        videos.map((video) => (
          <div
            key={video.key}
            className={`video-item ${selectedVideo?.key === video.key ? 'selected' : ''}`}
            onClick={() => onVideoSelect(video)}
          >
            <div className="video-item-name">
              {video.filename}
            </div>
            <div className="video-item-info">
              <div>{formatFileSize(video.size)}</div>
              <div>{formatDate(video.lastModified)}</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export default VideoList;