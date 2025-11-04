import React, { useState, useRef, useEffect } from 'react';
import api from '../services/api';
import WaveformDisplay from './WaveformDisplay';

function VideoTimeline({ videoInfo, currentTime, onSeek, videoKey }) {
  const [thumbnails, setThumbnails] = useState([]);
  const [waveform, setWaveform] = useState(null);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [seekTime, setSeekTime] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [hoverTime, setHoverTime] = useState(null);
  const [hoverPosition, setHoverPosition] = useState(null);
  const timelineRef = useRef(null);

  useEffect(() => {
    if (videoKey && videoInfo) {
      // Fetch actual thumbnails from the API
      const fetchThumbnails = async () => {
        try {
          console.log('Fetching thumbnails for video:', videoKey);
          console.log('Video duration:', videoInfo.duration, 'seconds');
          const thumbnailData = await api.getThumbnails(videoKey, { segmentDuration: 10 });
          console.log('Received thumbnails:', thumbnailData.length, 'thumbnails');
          console.log('Expected thumbnails for', videoInfo.duration, 'seconds:', Math.ceil(videoInfo.duration / 10));
          console.log('First few thumbnail times:', thumbnailData.slice(0, 5).map(t => t.time));
          setThumbnails(thumbnailData);
          
          // If some thumbnails are still missing, set up polling to check for updates
          const missingThumbnails = thumbnailData.filter(t => !t.data).length;
          if (missingThumbnails > 0) {
            console.log(`${missingThumbnails} thumbnails still missing, will poll for updates`);
            
            const pollInterval = setInterval(async () => {
              try {
                const updatedThumbnails = await api.getThumbnails(videoKey, { segmentDuration: 10 });
                const newlyAvailable = updatedThumbnails.filter(t => t.data).length;
                const previouslyAvailable = thumbnailData.filter(t => t.data).length;
                
                if (newlyAvailable > previouslyAvailable) {
                  console.log(`Found ${newlyAvailable - previouslyAvailable} new thumbnails`);
                  setThumbnails(updatedThumbnails);
                }
                
                // Stop polling when all thumbnails are available
                if (updatedThumbnails.every(t => t.data)) {
                  console.log('All thumbnails loaded, stopping poll');
                  clearInterval(pollInterval);
                }
              } catch (error) {
                console.warn('Thumbnail polling error:', error);
              }
            }, 2000); // Poll every 2 seconds
            
            // Clean up interval on unmount or when dependencies change
            return () => clearInterval(pollInterval);
          }
        } catch (error) {
          console.warn('Failed to fetch thumbnails, using placeholders:', error);
          // Fallback to placeholder segments if thumbnail fetch fails
          const totalSegments = Math.ceil(videoInfo.duration / 10);
          const placeholderThumbnails = [];
          for (let i = 0; i < totalSegments; i++) {
            placeholderThumbnails.push({
              segmentIndex: i,
              time: i * 10 + 5,
              data: null,
              cached: null,
              source: 'placeholder'
            });
          }
          setThumbnails(placeholderThumbnails);
        }
      };

      fetchThumbnails();
      
      // Fetch waveform data
      const fetchWaveform = async () => {
        try {
          setWaveformLoading(true);
          console.log('Fetching waveform for video:', videoKey);
          const waveformData = await api.getWaveform(videoKey, 10, 1000); // 1000 samples for good resolution
          console.log('Received waveform:', waveformData);
          setWaveform(waveformData);
        } catch (error) {
          console.warn('Failed to fetch waveform:', error);
          setWaveform(null);
        } finally {
          setWaveformLoading(false);
        }
      };
      
      fetchWaveform();
    }
  }, [videoKey, videoInfo]);


  const formatTime = (time) => {
    if (isNaN(time)) return '0:00';
    
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleTimelineClick = (e) => {
    if (!timelineRef.current || !videoInfo) return;
    
    const rect = timelineRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const newTime = percentage * videoInfo.duration;
    
    onSeek(Math.max(0, Math.min(newTime, videoInfo.duration)));
  };

  const handleTimelineMouseMove = (e) => {
    if (!timelineRef.current || !videoInfo) return;
    
    const rect = timelineRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const percentage = mouseX / rect.width;
    const time = percentage * videoInfo.duration;
    
    setHoverTime(time);
    setHoverPosition(mouseX);
  };

  const handleTimelineMouseLeave = () => {
    setHoverTime(null);
    setHoverPosition(null);
  };

  const handleSeekInputChange = (e) => {
    setSeekTime(e.target.value);
  };

  const handleSeekInputSubmit = (e) => {
    e.preventDefault();
    const time = parseTimeInput(seekTime);
    if (time !== null && time >= 0 && time <= videoInfo.duration) {
      onSeek(time);
      setSeekTime('');
    }
  };

  const parseTimeInput = (input) => {
    if (!input) return null;
    
    const parts = input.split(':').map(p => parseInt(p, 10));
    
    if (parts.length === 1) {
      return parts[0];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    
    return null;
  };

  const jumpToTime = (seconds) => {
    const newTime = Math.max(0, Math.min(currentTime + seconds, videoInfo.duration));
    onSeek(newTime);
  };

  if (!videoInfo) {
    return (
      <div style={{ padding: '1rem', textAlign: 'center', color: '#888' }}>
        Loading timeline...
      </div>
    );
  }

  const progressPercentage = (currentTime / videoInfo.duration) * 100;

  return (
    <div style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button className="btn" onClick={() => jumpToTime(-30)}>-30s</button>
          <button className="btn" onClick={() => jumpToTime(-10)}>-10s</button>
          <button className="btn" onClick={() => jumpToTime(-1)}>-1s</button>
          <button className="btn" onClick={() => jumpToTime(1)}>+1s</button>
          <button className="btn" onClick={() => jumpToTime(10)}>+10s</button>
          <button className="btn" onClick={() => jumpToTime(30)}>+30s</button>
        </div>
        
        <form onSubmit={handleSeekInputSubmit} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="text"
            className="seek-input"
            placeholder="mm:ss"
            value={seekTime}
            onChange={handleSeekInputChange}
          />
          <button type="submit" className="btn">Go</button>
        </form>
        
        <div style={{ marginLeft: 'auto', fontSize: '0.9rem', color: '#888' }}>
          Duration: {formatTime(videoInfo.duration)}
        </div>
      </div>

      <div 
        ref={timelineRef}
        style={{
          position: 'relative',
          height: '60px',
          backgroundColor: '#3a3a3a',
          borderRadius: '4px',
          cursor: 'pointer',
          overflow: 'hidden'
        }}
        onClick={handleTimelineClick}
        onMouseMove={handleTimelineMouseMove}
        onMouseLeave={handleTimelineMouseLeave}
      >
        <div style={{ display: 'flex', height: '100%' }}>
          {thumbnails.length > 0 ? thumbnails.map((thumb, index) => (
            <div
              key={index}
              style={{
                flex: 1,
                height: '100%',
                backgroundColor: thumb.data ? 'transparent' : '#4a4a4a',
                backgroundImage: thumb.data ? `url(${thumb.data})` : 'none',
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                borderRight: index < thumbnails.length - 1 ? '1px solid #2a2a2a' : 'none'
              }}
            />
          )) : (
            <div style={{ 
              display: 'flex', 
              height: '100%',
              backgroundColor: '#3a3a3a',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#888',
              fontSize: '0.9rem',
              width: '100%'
            }}>
              Loading segments...
            </div>
          )}
        </div>
        
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${progressPercentage}%`,
            height: '100%',
            backgroundColor: 'rgba(59, 130, 246, 0.4)',
            pointerEvents: 'none'
          }}
        />
        
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: `${progressPercentage}%`,
            width: '2px',
            height: '100%',
            backgroundColor: '#3b82f6',
            pointerEvents: 'none',
            transform: 'translateX(-1px)'
          }}
        />
        
        {hoverTime !== null && hoverPosition !== null && (
          <div
            style={{
              position: 'absolute',
              top: '-30px',
              left: `${hoverPosition}px`,
              transform: 'translateX(-50%)',
              backgroundColor: '#000',
              color: '#fff',
              padding: '4px 8px',
              borderRadius: '4px',
              fontSize: '0.8rem',
              pointerEvents: 'none',
              whiteSpace: 'nowrap'
            }}
          >
            {formatTime(hoverTime)}
          </div>
        )}
      </div>
      
      {/* Audio Waveform Display */}
      <div style={{ 
        marginTop: '0.5rem',
        borderRadius: '4px',
        overflow: 'hidden',
        backgroundColor: '#2a2a2a'
      }}>
        {waveformLoading ? (
          <div style={{
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#666',
            fontSize: '0.9rem'
          }}>
            Loading waveform...
          </div>
        ) : (
          <WaveformDisplay
            waveformData={waveform}
            width={timelineRef.current ? timelineRef.current.offsetWidth : 800}
            height={40}
            currentTime={currentTime}
            duration={videoInfo?.duration || 0}
            onSeek={onSeek}
          />
        )}
      </div>
      
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: '0.5rem',
        fontSize: '0.8rem',
        color: '#888'
      }}>
        <span>{formatTime(currentTime)}</span>
        <span>Click timeline/waveform to seek • {thumbnails.some(t => t.data) ? 'Thumbnails loaded' : 'Loading thumbnails...'} • {waveform?.hasAudio ? 'Waveform loaded' : waveformLoading ? 'Loading waveform...' : 'No audio'}</span>
        <span>{formatTime(videoInfo.duration)}</span>
      </div>
    </div>
  );
}

export default VideoTimeline;