import React, { useState, useEffect } from 'react';
import VideoList from './components/VideoList';
import VideoPlayer from './components/VideoPlayer';
import VideoTimeline from './components/VideoTimeline';
import api from './services/api';
import './index.css';

function App() {
  const [videos, setVideos] = useState([]);
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [videoInfo, setVideoInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [filters, setFilters] = useState({
    search: '',
    fileType: '',
    minSize: '',
    maxSize: '',
    dateFrom: '',
    dateTo: '',
    sortBy: 'name',
    sortOrder: 'asc'
  });

  useEffect(() => {
    loadVideos();
  }, [currentPath, filters]);

  const loadVideos = async () => {
    try {
      setLoading(true);
      const videoList = await api.getVideos(currentPath, filters);
      setVideos(videoList);
    } catch (err) {
      setError('Failed to load videos: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleFolderNavigate = (path) => {
    setCurrentPath(path);
    setSelectedVideo(null); // Clear selection when navigating
    setVideoInfo(null);
    setCurrentTime(0);
  };

  const handleFiltersChange = (newFilters) => {
    setFilters(newFilters);
    setSelectedVideo(null); // Clear selection when filtering
    setVideoInfo(null);
    setCurrentTime(0);
  };

  const selectVideo = async (video) => {
    try {
      setSelectedVideo(video);
      setVideoInfo(null);
      setCurrentTime(0);
      
      const info = await api.getVideoInfo(video.key);
      setVideoInfo(info);
    } catch (err) {
      setError('Failed to load video info: ' + err.message);
    }
  };

  const handleTimeUpdate = (time) => {
    if (!seeking) {
      setCurrentTime(time);
    }
  };

  const handleSeek = (time) => {
    setSeeking(true);
    setCurrentTime(time);
    setTimeout(() => setSeeking(false), 100);
  };

  if (loading) {
    return (
      <div className="app">
        <header className="header">
          <h1>Web Video Review</h1>
        </header>
        <div className="loading">Loading videos...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app">
        <header className="header">
          <h1>Web Video Review</h1>
        </header>
        <div className="error">{error}</div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Web Video Review</h1>
      </header>
      
      <div className="main-content">
        <div className="sidebar">
          <VideoList
            videos={videos}
            selectedVideo={selectedVideo}
            onVideoSelect={selectVideo}
            onRefresh={loadVideos}
            currentPath={currentPath}
            onFolderNavigate={handleFolderNavigate}
            currentFilters={filters}
            onFiltersChange={handleFiltersChange}
          />
        </div>
        
        <div className="video-content">
          <div className="video-player-container">
            {selectedVideo ? (
              <VideoPlayer
                videoKey={selectedVideo.key}
                videoInfo={videoInfo}
                currentTime={currentTime}
                onTimeUpdate={handleTimeUpdate}
                seeking={seeking}
              />
            ) : (
              <div className="loading">
                Select a video to start reviewing
              </div>
            )}
          </div>
          
          {selectedVideo && videoInfo && (
            <div className="timeline-container">
              <VideoTimeline
                videoInfo={videoInfo}
                currentTime={currentTime}
                onSeek={handleSeek}
                videoKey={selectedVideo.key}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;