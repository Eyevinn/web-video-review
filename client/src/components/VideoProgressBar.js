import React, { useState, useEffect } from 'react';
import api from '../services/api';

function VideoProgressBar({ videoKey, onReady }) {
  const [progress, setProgress] = useState({
    status: 'initializing',
    message: 'Preparing video...',
    downloadProgress: 0,
    processingProgress: 0,
    overallProgress: 0,
    estimatedTimeRemaining: null,
    ready: false
  });
  const [, setFailureCount] = useState(0);

  useEffect(() => {
    if (!videoKey) return;

    let pollInterval;
    
    const pollProgress = async () => {
      try {
        const progressData = await api.getVideoProgress(videoKey);
        setProgress(progressData);
        
        if (progressData.ready) {
          clearInterval(pollInterval);
          setFailureCount(0);
          // Don't call onReady here, let the timeout in the render do it
        } else {
          // Reset failure count on successful response
          setFailureCount(0);
        }
      } catch (error) {
        console.error('Error polling progress:', error);
        setFailureCount(prev => {
          const newCount = prev + 1;
          
          // If progress endpoint fails repeatedly, fall back to showing player
          if (newCount >= 10) {
            console.warn('Progress endpoint failed repeatedly, falling back to direct player');
            clearInterval(pollInterval);
            if (onReady) {
              onReady();
            }
            return newCount;
          }
          
          // Update error message
          setProgress(prevProgress => ({
            ...prevProgress,
            status: 'error',
            message: `Error loading video (attempt ${newCount}/10)`
          }));
          
          return newCount;
        });
      }
    };

    // Start polling after a delay to let the playlist request trigger HLS generation first
    setTimeout(() => {
      pollProgress();
      pollInterval = setInterval(pollProgress, 2000); // Poll every 2 seconds instead of 1
    }, 1000);

    return () => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [videoKey, onReady]);

  const formatTime = (seconds) => {
    if (!seconds || seconds <= 0) return '';
    
    if (seconds < 60) {
      return `${seconds}s`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return `${minutes}m ${remainingSeconds}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
  };

  // Only hide progress bar when explicitly ready and after showing status
  if (progress.ready && progress.status === 'ready' && progress.overallProgress >= 100) {
    // Small delay to show the completion state
    setTimeout(() => {
      if (onReady) {
        onReady();
      }
    }, 2000);
    
    // Show completion state briefly
  }

  return (
    <div style={{
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      padding: '2rem',
      borderRadius: '8px',
      color: 'white',
      textAlign: 'center',
      minWidth: '400px',
      zIndex: 1000
    }}>
      <div style={{ marginBottom: '1rem' }}>
        <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.2rem' }}>
          Loading Video
        </h3>
        <p style={{ margin: '0', color: '#ccc', fontSize: '0.9rem' }}>
          {progress.message}
        </p>
      </div>

      {/* Overall Progress Bar */}
      <div style={{
        width: '100%',
        height: '8px',
        backgroundColor: '#333',
        borderRadius: '4px',
        overflow: 'hidden',
        marginBottom: '1rem'
      }}>
        <div style={{
          width: `${progress.overallProgress}%`,
          height: '100%',
          backgroundColor: '#3b82f6',
          transition: 'width 0.3s ease'
        }} />
      </div>

      {/* Progress Details */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: '0.8rem',
        color: '#888',
        marginBottom: '1rem'
      }}>
        <span>Download: {progress.downloadProgress}%</span>
        <span>Processing: {progress.processingProgress}%</span>
        <span>Overall: {progress.overallProgress}%</span>
      </div>

      {/* Estimated Time */}
      {progress.estimatedTimeRemaining && (
        <div style={{
          fontSize: '0.8rem',
          color: '#ccc'
        }}>
          Estimated time remaining: {formatTime(progress.estimatedTimeRemaining)}
        </div>
      )}

      {/* Status-specific indicators */}
      {progress.status === 'downloading' && (
        <div style={{
          fontSize: '0.8rem',
          color: '#3b82f6',
          marginTop: '0.5rem'
        }}>
          📥 Downloading from cloud storage...
        </div>
      )}

      {progress.status === 'processing' && (
        <div style={{
          fontSize: '0.8rem',
          color: '#10b981',
          marginTop: '0.5rem'
        }}>
          ⚡ Generating video segments...
        </div>
      )}

      {progress.status === 'error' && (
        <div style={{
          fontSize: '0.8rem',
          color: '#ef4444',
          marginTop: '0.5rem'
        }}>
          ❌ Error loading video
        </div>
      )}
    </div>
  );
}

export default VideoProgressBar;