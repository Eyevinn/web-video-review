import React, { useState, useRef, useEffect } from 'react';
import api from '../services/api';

function VideoTimeline({ videoInfo, currentTime, onSeek, videoKey }) {
  const [thumbnails, setThumbnails] = useState([]);
  const [seekTime, setSeekTime] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [hoverTime, setHoverTime] = useState(null);
  const [hoverPosition, setHoverPosition] = useState(null);
  const timelineRef = useRef(null);

  useEffect(() => {
    if (videoKey && videoInfo) {
      // Thumbnails disabled for performance - show placeholder segments
      const totalSegments = Math.ceil(videoInfo.duration / 10);
      const placeholderThumbnails = [];
      for (let i = 0; i < totalSegments; i++) {
        placeholderThumbnails.push({
          segmentIndex: i,
          time: i * 10 + 5,
          data: null,
          cached: null
        });
      }
      setThumbnails(placeholderThumbnails);
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
                backgroundImage: thumb.data ? `url(data:image/png;base64,${thumb.data})` : 'none',
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
      
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: '0.5rem',
        fontSize: '0.8rem',
        color: '#888'
      }}>
        <span>{formatTime(currentTime)}</span>
        <span>Click timeline to seek • Thumbnails disabled for performance</span>
        <span>{formatTime(videoInfo.duration)}</span>
      </div>
    </div>
  );
}

export default VideoTimeline;