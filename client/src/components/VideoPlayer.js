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
          maxBufferLength: 30, // Reduced for real-time encoding
          maxMaxBufferLength: 60, // Smaller max buffer for faster startup
          maxBufferSize: 60 * 1000 * 1000, // Reduced buffer size
          maxBufferHole: 2.0, // Allow larger buffer holes for encoding delays
          highBufferWatchdogPeriod: 10, // More lenient buffer watchdog
          nudgeOffset: 0.5, // Larger nudge offset for timing issues
          nudgeMaxRetry: 3, // Fewer retries to prevent stalls
          maxFragLookUpTolerance: 1.0, // More tolerance for fragment lookup
          liveSyncDurationCount: 1, // Minimum allowed value  
          liveMaxLatencyDurationCount: 2, // Must be greater than liveSyncDurationCount
          liveDurationInfinity: false,
          liveBackBufferLength: 0, // Disable live back buffer
          enableSoftwareAES: true,
          manifestLoadingTimeOut: 30000, // Reasonable manifest timeout
          manifestLoadingMaxRetry: 3, // Fewer manifest retries
          manifestLoadingRetryDelay: 2000, // Shorter retry delay
          levelLoadingTimeOut: 30000, // Reasonable level timeout
          levelLoadingMaxRetry: 3, // Fewer level retries
          levelLoadingRetryDelay: 2000, // Shorter retry delay
          fragLoadingTimeOut: 20000, // Extended timeout for MXF and complex files
          fragLoadingMaxRetry: 3, // Fewer fragment retries to prevent cascade failures
          fragLoadingRetryDelay: 2000, // Reasonable retry delay
          startFragPrefetch: false, // Disable prefetch for real-time encoding
          testBandwidth: false, // Disable bandwidth testing
          abrEwmaFastLive: 5.0, // More conservative ABR for real-time
          abrEwmaSlowLive: 15.0, // Very conservative ABR
          abrMaxWithRealBitrate: false, // Disable real bitrate ABR
          maxStarvationDelay: 25, // Extended starvation delay for MXF files
          maxLoadingDelay: 25, // Extended loading delay for MXF files
          startPosition: 0, // Start from beginning instead of live edge
          autoStartLoad: false // Prevent auto-seeking to live edge
        });
        
        hlsRef.current = hls;
        
        const playlistUrl = api.getHLSPlaylistUrl(videoKey);
        hls.loadSource(playlistUrl);
        hls.attachMedia(video);
        
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          console.log('HLS manifest parsed');
          // Manually start loading from beginning
          hls.startLoad(0);
        });
        
        let userCurrentTime = 0;
        let preventSeek = false;
        
        hls.on(Hls.Events.LEVEL_LOADING, (event, data) => {
          // Store current time BEFORE playlist loading starts
          const video = videoRef.current;
          if (video && !seeking && video.currentTime > 0) {
            userCurrentTime = video.currentTime;
            preventSeek = true;
            console.log('Level loading, storing position:', userCurrentTime);
          }
        });
        
        hls.on(Hls.Events.LEVEL_LOADED, (event, data) => {
          // Keep the prevention active after level loads
          const video = videoRef.current;
          if (video && preventSeek) {
            console.log('Level loaded, maintaining stored position:', userCurrentTime);
            
            // Reset flag after a longer delay to ensure the seek is blocked
            setTimeout(() => {
              preventSeek = false;
              console.log('Re-enabling seeks after level update');
            }, 1000);
          }
        });
        
        // Prevent unwanted seeking using timeupdate event
        video.addEventListener('timeupdate', () => {
          if (preventSeek && userCurrentTime > 0 && !seeking) {
            const currentTime = video.currentTime;
            if (Math.abs(currentTime - userCurrentTime) > 5) {
              console.log('Detected unwanted seek from', userCurrentTime, 'to', currentTime, '- correcting');
              video.currentTime = userCurrentTime;
            }
          }
        });
        
        // Also listen for seeking events
        video.addEventListener('seeking', () => {
          if (preventSeek && userCurrentTime > 0 && !seeking) {
            const targetTime = video.currentTime;
            if (Math.abs(targetTime - userCurrentTime) > 5) {
              console.log('Preventing seek from', userCurrentTime, 'to', targetTime);
              video.currentTime = userCurrentTime;
            }
          }
        });
        
        hls.on(Hls.Events.FRAG_LOADING, (event, data) => {
          console.log('Loading fragment:', data.frag.relurl);
        });
        
        hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
          const loadTime = data.stats && data.stats.loading 
            ? data.stats.loading.end - data.stats.loading.start 
            : 'unknown';
          console.log('Fragment loaded:', data.frag.relurl, 'in', loadTime, 'ms');
          console.log('Fragment details:', {
            start: data.frag.start,
            end: data.frag.end,
            duration: data.frag.duration,
            sn: data.frag.sn
          });
          
          // Track loaded fragments and implement buffering strategy for real-time encoding
          setLoadedFragments(prev => {
            const newCount = prev + 1;
            console.log(`Loaded fragments: ${newCount}`);
            
            // Wait for 3 fragments before allowing playback for real-time encoding
            if (newCount >= 3 && isBuffering) {
              console.log('Sufficient buffer available for real-time encoding, ready for playback');
              setIsBuffering(false);
            }
            
            return newCount;
          });
        });
        
        // Add buffer state monitoring
        hls.on(Hls.Events.BUFFER_APPENDED, (event, data) => {
          console.log('Buffer appended:', {
            type: data.type,
            timeRanges: data.timeRanges
          });
          
          // Check for buffer gaps that might cause stalls
          if (video.buffered.length > 0) {
            const currentTime = video.currentTime;
            let hasGap = false;
            
            for (let i = 0; i < video.buffered.length - 1; i++) {
              const gapStart = video.buffered.end(i);
              const gapEnd = video.buffered.start(i + 1);
              const gapSize = gapEnd - gapStart;
              
              if (gapSize > 0.1 && currentTime >= gapStart - 1 && currentTime <= gapEnd + 1) {
                console.warn(`Buffer gap detected: ${gapStart.toFixed(2)}s - ${gapEnd.toFixed(2)}s (${gapSize.toFixed(2)}s gap) near currentTime: ${currentTime.toFixed(2)}s`);
                hasGap = true;
              }
            }
            
            if (!hasGap) {
              console.log(`Buffer continuous from ${video.buffered.start(0).toFixed(2)}s to ${video.buffered.end(video.buffered.length - 1).toFixed(2)}s`);
            }
          }
        });
        
        hls.on(Hls.Events.ERROR, (event, data) => {
          console.error('HLS error:', data);
          
          // Enhanced buffer stall handling for MXF files
          if (data.details === 'bufferStalledError') {
            console.log('Buffer stalled error detected, analyzing buffer state...');
            
            if (video.buffered.length > 0) {
              console.log('Current buffer ranges:');
              for (let i = 0; i < video.buffered.length; i++) {
                console.log(`  Range ${i}: ${video.buffered.start(i).toFixed(2)}s - ${video.buffered.end(i).toFixed(2)}s`);
              }
              console.log(`Current time: ${video.currentTime.toFixed(2)}s`);
              
              // Try to recover by seeking slightly forward if we're near a buffer gap
              const currentTime = video.currentTime;
              let nearestBufferStart = null;
              
              for (let i = 0; i < video.buffered.length; i++) {
                const bufferStart = video.buffered.start(i);
                const bufferEnd = video.buffered.end(i);
                
                if (bufferStart > currentTime && (nearestBufferStart === null || bufferStart < nearestBufferStart)) {
                  nearestBufferStart = bufferStart;
                }
              }
              
              if (nearestBufferStart !== null && nearestBufferStart - currentTime < 2) {
                console.log(`Attempting recovery by seeking to ${nearestBufferStart.toFixed(2)}s`);
                video.currentTime = nearestBufferStart + 0.1;
                return;
              }
            }
            
            // For non-fatal buffer stalls, try reloading
            if (!data.fatal) {
              console.log('Attempting buffer stall recovery...');
              hls.startLoad();
              return;
            }
          }
          
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
          ⏳ Buffering... ({loadedFragments}/3 chunks loaded)
        </div>
      )}
    </div>
  );
}

export default VideoPlayer;