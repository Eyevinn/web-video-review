import React, { useRef, useEffect, useState } from 'react';
import Hls from 'hls.js';
import api from '../services/api';

function VideoPlayer({ videoKey, videoInfo, currentTime, onTimeUpdate, seeking }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [error, setError] = useState(null);
  const [loadedFragments, setLoadedFragments] = useState(0);
  const [isBuffering, setIsBuffering] = useState(true);

  useEffect(() => {
    if (!videoKey || !videoRef.current) return;

    const video = videoRef.current;
    
    const initializePlayer = () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
      
      // Reset buffering state for new video
      setLoadedFragments(0);
      setIsBuffering(true);

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 30,
          maxBufferLength: 120, // Increase buffer length for slow-encoding videos
          maxMaxBufferLength: 180, // Even larger max buffer
          maxBufferSize: 120 * 1000 * 1000, // Doubled buffer size
          maxBufferHole: 1.0, // Allow larger buffer holes
          highBufferWatchdogPeriod: 5, // Less aggressive buffer watchdog
          nudgeOffset: 0.1,
          nudgeMaxRetry: 6, // More retries for nudging
          maxFragLookUpTolerance: 0.5, // More tolerance for fragment lookup
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          liveDurationInfinity: false,
          enableSoftwareAES: true,
          manifestLoadingTimeOut: 45000, // Longer manifest timeout
          manifestLoadingMaxRetry: 4, // More manifest retries
          manifestLoadingRetryDelay: 3000, // Longer retry delay
          levelLoadingTimeOut: 45000, // Longer level timeout
          levelLoadingMaxRetry: 5, // More level retries
          levelLoadingRetryDelay: 3000, // Longer retry delay
          fragLoadingTimeOut: 120000, // Much longer fragment timeout for slow segments
          fragLoadingMaxRetry: 6, // More fragment retries
          fragLoadingRetryDelay: 5000, // Longer fragment retry delay
          startFragPrefetch: true,
          testBandwidth: true,
          abrEwmaFastLive: 3.0, // More conservative ABR
          abrEwmaSlowLive: 9.0,
          abrMaxWithRealBitrate: false, // Disable real bitrate ABR to avoid switching
          maxStarvationDelay: 8, // Allow longer starvation before giving up
          maxLoadingDelay: 8 // Allow longer loading delay
        });
        
        hlsRef.current = hls;
        
        const playlistUrl = api.getHLSPlaylistUrl(videoKey);
        hls.loadSource(playlistUrl);
        hls.attachMedia(video);
        
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          console.log('HLS manifest parsed');
        });
        
        hls.on(Hls.Events.FRAG_LOADING, (event, data) => {
          console.log('Loading fragment:', data.frag.relurl);
        });
        
        hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
          const loadTime = data.stats && data.stats.loading 
            ? data.stats.loading.end - data.stats.loading.start 
            : 'unknown';
          console.log('Fragment loaded:', data.frag.relurl, 'in', loadTime, 'ms');
          
          // Track loaded fragments and implement buffering strategy
          setLoadedFragments(prev => {
            const newCount = prev + 1;
            console.log(`Loaded fragments: ${newCount}`);
            
            // Wait for 2 fragments before allowing playback
            if (newCount >= 2 && isBuffering) {
              console.log('Sufficient buffer available, ready for playback');
              setIsBuffering(false);
            }
            
            return newCount;
          });
        });
        
        hls.on(Hls.Events.ERROR, (event, data) => {
          console.error('HLS error:', data);
          
          // Don't treat internal exceptions as fatal unless they truly are
          if (data.details === 'internalException' && !data.fatal) {
            console.warn('Non-fatal internal exception, continuing...');
            return;
          }
          
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            console.log('Network error, attempting recovery...');
            if (data.fatal) {
              hls.startLoad();
            }
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            console.log('Media error, attempting recovery...');
            if (data.fatal) {
              hls.recoverMediaError();
            }
          } else if (data.fatal) {
            setError(`Video streaming error: ${data.details}`);
          }
        });
        
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        const playlistUrl = api.getHLSPlaylistUrl(videoKey);
        video.src = playlistUrl;
      } else {
        const streamUrl = api.getVideoStreamUrl(videoKey);
        video.src = streamUrl;
      }
    };

    initializePlayer();

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [videoKey]);

  useEffect(() => {
    if (!videoRef.current || !seeking) return;
    
    const video = videoRef.current;
    if (Math.abs(video.currentTime - currentTime) > 1) {
      video.currentTime = currentTime;
    }
  }, [currentTime, seeking]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      onTimeUpdate(video.currentTime);
    };

    const handleDurationChange = () => {
      setDuration(video.duration);
    };

    const handleProgress = () => {
      if (video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        setBuffered(bufferedEnd);
      }
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('durationchange', handleDurationChange);
    video.addEventListener('progress', handleProgress);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('volumechange', handleVolumeChange);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('durationchange', handleDurationChange);
      video.removeEventListener('progress', handleProgress);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('volumechange', handleVolumeChange);
    };
  }, [onTimeUpdate]);

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;

    // Don't allow play if still buffering
    if (isBuffering && !isPlaying) {
      console.log('Still buffering, waiting for more fragments...');
      return;
    }

    if (isPlaying) {
      video.pause();
    } else {
      video.play().catch(err => {
        console.error('Play failed:', err);
        setError('Failed to play video');
      });
    }
  };

  const handleVolumeChange = (e) => {
    const video = videoRef.current;
    if (!video) return;
    
    const newVolume = parseFloat(e.target.value);
    video.volume = newVolume;
    setVolume(newVolume);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    
    video.muted = !video.muted;
    setMuted(video.muted);
  };

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

  if (error) {
    return (
      <div className="error" style={{ padding: '2rem' }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <video
          ref={videoRef}
          className="video-player"
          controls={false}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            backgroundColor: '#000'
          }}
        />
      </div>
      
      <div className="video-controls" style={{ 
        display: 'flex', 
        alignItems: 'center', 
        gap: '1rem',
        padding: '0.75rem 1rem',
        backgroundColor: '#2a2a2a',
        borderTop: '1px solid #3a3a3a'
      }}>
        <button className="btn" onClick={togglePlayPause} disabled={isBuffering && !isPlaying}>
          {isBuffering && !isPlaying ? '⏳' : (isPlaying ? '⏸️' : '▶️')}
        </button>
        
        <span style={{ fontSize: '0.9rem', minWidth: '100px' }}>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button className="btn" onClick={toggleMute} style={{ padding: '0.25rem 0.5rem' }}>
            {muted ? '🔇' : '🔊'}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={muted ? 0 : volume}
            onChange={handleVolumeChange}
            style={{ width: '80px' }}
          />
        </div>
        
        {videoInfo && (
          <div style={{ marginLeft: 'auto', fontSize: '0.8rem', color: '#888' }}>
            {videoInfo.video && (
              <>
                {videoInfo.video.width}x{videoInfo.video.height} • 
                {videoInfo.video.codec} • 
                {Math.round(videoInfo.video.fps)}fps
              </>
            )}
          </div>
        )}
      </div>
      
      {isBuffering && (
        <div style={{
          padding: '0.5rem 1rem',
          backgroundColor: '#1a1a1a',
          color: '#888',
          fontSize: '0.8rem',
          textAlign: 'center',
          borderTop: '1px solid #3a3a3a'
        }}>
          ⏳ Buffering... ({loadedFragments}/2 chunks loaded)
        </div>
      )}
    </div>
  );
}

export default VideoPlayer;