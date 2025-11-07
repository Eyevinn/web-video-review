import React, { useRef, useEffect, useState, useCallback } from 'react';
import Hls from 'hls.js';
import api from '../services/api';
import VideoProgressBar from './VideoProgressBar';
import EbuR128Monitor from './EbuR128Monitor';

function VideoPlayer({ videoKey, videoInfo, currentTime, onTimeUpdate, seeking, onActiveAudioStreamChange, onSwitchAudioTrackRef }) {
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
  const [showProgress, setShowProgress] = useState(true);
  const [progressReady, setProgressReady] = useState(false);
  const [activeAudioTrack, setActiveAudioTrack] = useState(null);
  const [availableAudioTracks, setAvailableAudioTracks] = useState([]);
  const [expectedFragments, setExpectedFragments] = useState(3); // Default to 3, will be calculated based on video duration
  

  const switchAudioTrack = useCallback((trackIndex) => {
    const video = videoRef.current;
    if (!video) return;

    console.log(`Switching to audio track ${trackIndex}`);

    // Try HLS audio track switching first
    if (hlsRef.current && hlsRef.current.audioTracks && hlsRef.current.audioTracks.length > trackIndex) {
      console.log('Switching HLS audio track');
      hlsRef.current.audioTrack = trackIndex;
      return;
    }

    // Try native HTML5 audio track switching
    if (video.audioTracks && video.audioTracks.length > trackIndex) {
      console.log('Switching native audio track');
      // Disable all tracks first
      for (let i = 0; i < video.audioTracks.length; i++) {
        video.audioTracks[i].enabled = false;
      }
      // Enable the selected track
      video.audioTracks[trackIndex].enabled = true;
      return;
    }

    console.warn('Audio track switching not supported for this video format');
  }, []);

  useEffect(() => {
    if (!videoKey || !videoRef.current) return;

    const video = videoRef.current;
    
    // Reset all player states for new video
    setShowProgress(true);
    setProgressReady(false);
    setIsPlaying(false);
    setError(null);
    
    const detectAudioTracks = () => {
      const video = videoRef.current;
      if (!video) return;

      let activeTrackInfo = null;
      let availableTracks = [];

      // Try HLS audio tracks first
      if (hlsRef.current && hlsRef.current.audioTracks) {
        const audioTracks = hlsRef.current.audioTracks;
        const activeTrackId = hlsRef.current.audioTrack;
        
        // Build available tracks list from HLS
        availableTracks = audioTracks.map((track, index) => ({
          index: index,
          name: track.name || `Track ${index + 1}`,
          language: track.lang || track.language,
          codec: track.codec,
          channels: track.channels,
          source: 'hls'
        }));
        
        if (audioTracks.length > 0) {
          const activeTrack = audioTracks[activeTrackId];
          if (activeTrack) {
            activeTrackInfo = {
              index: activeTrackId,
              name: activeTrack.name || `Track ${activeTrackId + 1}`,
              language: activeTrack.lang || activeTrack.language,
              codec: activeTrack.codec,
              channels: activeTrack.channels,
              source: 'hls'
            };
          }
        }
      }

      // Fallback to native HTML5 audio tracks
      if (!activeTrackInfo && video.audioTracks && video.audioTracks.length > 0) {
        // Build available tracks list from native tracks
        availableTracks = Array.from(video.audioTracks).map((track, index) => ({
          index: index,
          name: track.label || `Track ${index + 1}`,
          language: track.language,
          source: 'native'
        }));

        for (let i = 0; i < video.audioTracks.length; i++) {
          const track = video.audioTracks[i];
          if (track.enabled) {
            activeTrackInfo = {
              index: i,
              name: track.label || `Track ${i + 1}`,
              language: track.language,
              source: 'native'
            };
            break;
          }
        }
      }

      // Fallback to videoInfo audio streams
      if (!activeTrackInfo && videoInfo && videoInfo.audioStreams && videoInfo.audioStreams.length > 0) {
        // Build available tracks list from video info
        availableTracks = videoInfo.audioStreams.map((stream, index) => ({
          index: index,
          name: stream.title || stream.language || `Track ${index + 1}`,
          language: stream.language,
          codec: stream.codec,
          channels: stream.channels,
          channelLayout: stream.channelLayout,
          source: 'videoInfo'
        }));

        activeTrackInfo = {
          index: 0,
          name: 'Default Audio',
          source: 'assumed'
        };
      }

      console.log('Detected active audio track:', activeTrackInfo);
      console.log('Available audio tracks:', availableTracks);
      
      setActiveAudioTrack(activeTrackInfo);
      setAvailableAudioTracks(availableTracks);
      
      // Notify parent component
      if (onActiveAudioStreamChange) {
        onActiveAudioStreamChange(activeTrackInfo);
      }
    };

    const initializePlayer = () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
      
      // Reset buffering state for new video
      setLoadedFragments(0);
      setIsBuffering(true);
      
      // Reset to default, will be calculated when videoInfo is available
      setExpectedFragments(3);
      
      // Initialize HLS immediately - this will trigger generation if needed
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
          autoStartLoad: false, // Prevent auto-seeking to live edge
          forceKeyFrameOnDiscontinuity: true, // Better seeking behavior
          liveDurationInfinity: false, // Disable infinite live duration
          liveBackBufferLength: 0 // No back buffer for live streams
        });
        
        hlsRef.current = hls;
        
        // Get playlist URL and load (always with goniometer, test EBU R128)
        const playlistUrl = api.getHLSPlaylistUrl(videoKey, 10, { goniometer: true, ebuR128: true });
        console.log(`[VideoPlayer] Loading HLS playlist: ${playlistUrl} (with goniometer)`);
        hls.loadSource(playlistUrl);
        hls.attachMedia(video);
        
        hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
          // Force start from beginning, not live edge
          hls.startLoad(0);
          
          // If this is detected as a live stream, force seek to beginning
          if (data.levels && data.levels.length > 0 && data.levels[0].details?.live) {
            console.log('Live stream detected, forcing start position to 0');
            // Set up one-time listener to correct position after video loads
            const handleLoadedData = () => {
              const video = videoRef.current;
              if (video && video.currentTime > 5) { // If player jumped to live edge
                console.log('Correcting live edge jump on loadeddata, seeking to start');
                video.currentTime = 0;
              }
              video.removeEventListener('loadeddata', handleLoadedData);
            };
            video.addEventListener('loadeddata', handleLoadedData, { once: true });
          }
          
          // Initialize audio track detection
          detectAudioTracks();
        });
        
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
          detectAudioTracks();
        });
        
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
          console.log('Audio track switched to:', data);
          detectAudioTracks();
        });
        
        let userCurrentTime = 0;
        let preventSeek = false;
        let isInitialLoad = true;
        
        hls.on(Hls.Events.LEVEL_LOADING, (event, data) => {
          // Store current time BEFORE playlist loading starts
          const video = videoRef.current;
          if (video && !seeking && video.currentTime > 0) {
            userCurrentTime = video.currentTime;
            preventSeek = true;
            isInitialLoad = false; // No longer initial load once we have playback position
            console.log('Level loading, storing position:', userCurrentTime);
          }
        });
        
        hls.on(Hls.Events.LEVEL_LOADED, (event, data) => {
          // Keep the prevention active after level loads
          const video = videoRef.current;
          if (video && preventSeek && userCurrentTime > 0 && !isInitialLoad) {
            console.log('Level loaded, maintaining stored position:', userCurrentTime);
            
            // Check if the level loaded is updating the playlist (live edge behavior)
            if (data.details && data.details.live) {
              console.log('Live playlist detected, preventing live edge seek');
              // Immediately restore position if video tried to jump
              if (Math.abs(video.currentTime - userCurrentTime) > 2) {
                console.log('Correcting live edge jump from', video.currentTime, 'to', userCurrentTime);
                video.currentTime = userCurrentTime;
              }
            }
            
            // Reset flag after a longer delay to ensure the seek is blocked
            setTimeout(() => {
              preventSeek = false;
              console.log('Re-enabling seeks after level update');
            }, 1500);
          } else if (isInitialLoad && data.details && data.details.live) {
            console.log('Initial live playlist load, allowing natural position');
            isInitialLoad = false; // Mark as no longer initial load
          }
        });
        
        // Prevent unwanted seeking using timeupdate event
        video.addEventListener('timeupdate', () => {
          if (preventSeek && userCurrentTime > 0 && !seeking && !isInitialLoad) {
            const currentTime = video.currentTime;
            // More sensitive detection for playlist updates (2 seconds instead of 5)
            if (Math.abs(currentTime - userCurrentTime) > 2) {
              console.log('Detected unwanted seek from', userCurrentTime, 'to', currentTime, '- correcting');
              video.currentTime = userCurrentTime;
            }
          }
        });
        
        // Also listen for seeking events
        video.addEventListener('seeking', () => {
          if (preventSeek && userCurrentTime > 0 && !seeking && !isInitialLoad) {
            const targetTime = video.currentTime;
            // More sensitive detection for playlist updates (2 seconds instead of 5)
            if (Math.abs(targetTime - userCurrentTime) > 2) {
              console.log('Preventing seek from', userCurrentTime, 'to', targetTime);
              video.currentTime = userCurrentTime;
            }
          }
        });
        
        hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
          
          // Track loaded fragments and implement buffering strategy for real-time encoding
          setLoadedFragments(prev => {
            const newCount = prev + 1;
            
            // Wait for expectedFragments before allowing playback (adaptive for short videos)
            if (newCount >= expectedFragments && isBuffering) {
              console.log(`Buffering complete: ${newCount}/${expectedFragments} fragments loaded`);
              // Store current position before changing buffering state to prevent seek
              const video = videoRef.current;
              if (video && !seeking) {
                const currentPos = video.currentTime;
                setIsBuffering(false);
                // Ensure position hasn't changed after state update
                setTimeout(() => {
                  if (video.currentTime !== currentPos) {
                    console.log('Correcting position after buffering complete:', currentPos);
                    video.currentTime = currentPos;
                  }
                }, 0);
              } else {
                setIsBuffering(false);
              }
            }
            
            return newCount;
          });
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
        // Native HLS support (always with goniometer, test EBU R128)
        const playlistUrl = api.getHLSPlaylistUrl(videoKey, 10, { goniometer: true, ebuR128: true });
        console.log(`[VideoPlayer] Loading native HLS: ${playlistUrl} (with goniometer)`);
        video.src = playlistUrl;
        
        // Detect audio tracks after video loads
        video.addEventListener('loadedmetadata', detectAudioTracks);
      } else {
        const streamUrl = api.getVideoStreamUrl(videoKey);
        video.src = streamUrl;
        
        // Detect audio tracks after video loads
        video.addEventListener('loadedmetadata', detectAudioTracks);
      }
    };

    // Initialize player immediately - this will trigger HLS generation and progress tracking
    initializePlayer();

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [videoKey]);

  // Calculate expected fragments when videoInfo becomes available
  useEffect(() => {
    if (videoInfo && videoInfo.duration) {
      const segmentDuration = 10; // Default segment duration
      const calculatedFragments = Math.ceil(videoInfo.duration / segmentDuration);
      const minFragmentsNeeded = Math.min(3, Math.max(1, Math.ceil(calculatedFragments / 2)));
      setExpectedFragments(minFragmentsNeeded);
      console.log(`Video duration: ${videoInfo.duration}s, expected fragments: ${calculatedFragments}, buffering threshold: ${minFragmentsNeeded}`);
    }
  }, [videoInfo]);

  // Expose switchAudioTrack function to parent component
  useEffect(() => {
    if (onSwitchAudioTrackRef) {
      onSwitchAudioTrackRef(switchAudioTrack);
    }
  }, [onSwitchAudioTrackRef, switchAudioTrack]);

  const handleProgressReady = () => {
    setProgressReady(true);
    setShowProgress(false);
  };

  useEffect(() => {
    if (!videoRef.current || !seeking || isBuffering) return;
    
    const video = videoRef.current;
    if (Math.abs(video.currentTime - currentTime) > 1) {
      video.currentTime = currentTime;
    }
  }, [currentTime, seeking, isBuffering]);

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

  // Add comprehensive keyboard shortcuts for video control
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Only handle keys when video player area is focused or no input is focused
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
      }
      
      switch (e.key) {
        // Frame stepping
        case 'ArrowLeft':
          e.preventDefault();
          stepBackward();
          break;
        case 'ArrowRight':
          e.preventDefault();
          stepForward();
          break;
        
        // Alternative frame stepping (common in video editors)
        case ',':
        case '<':
          e.preventDefault();
          stepBackward();
          break;
        case '.':
        case '>':
          e.preventDefault();
          stepForward();
          break;
        
        // Play/Pause controls
        case ' ':
          e.preventDefault();
          togglePlayPause();
          break;
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlayPause();
          break;
        
        // Additional useful shortcuts
        case 'j':
        case 'J':
          e.preventDefault();
          // Skip backward 10 seconds
          const video = videoRef.current;
          if (video) {
            video.currentTime = Math.max(0, video.currentTime - 10);
          }
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          // Skip forward 10 seconds
          const videoForward = videoRef.current;
          if (videoForward) {
            videoForward.currentTime = Math.min(videoForward.duration || 0, videoForward.currentTime + 10);
          }
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          toggleMute();
          break;
        
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [videoInfo]); // Include videoInfo as dependency since stepForward/stepBackward use it

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

  const stepBackward = () => {
    const video = videoRef.current;
    if (!video) return;
    
    // Calculate frame duration based on video fps
    const fps = (videoInfo && videoInfo.video && videoInfo.video.fps) ? videoInfo.video.fps : 25;
    const frameDuration = 1 / fps;
    
    // Step back one frame
    const newTime = Math.max(0, video.currentTime - frameDuration);
    video.currentTime = newTime;
    
    // Ensure video is paused for frame stepping
    if (!video.paused) {
      video.pause();
    }
  };

  const stepForward = () => {
    const video = videoRef.current;
    if (!video) return;
    
    // Calculate frame duration based on video fps
    const fps = (videoInfo && videoInfo.video && videoInfo.video.fps) ? videoInfo.video.fps : 25;
    const frameDuration = 1 / fps;
    
    // Step forward one frame
    const newTime = Math.min(video.duration || 0, video.currentTime + frameDuration);
    video.currentTime = newTime;
    
    // Ensure video is paused for frame stepping
    if (!video.paused) {
      video.pause();
    }
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
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
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
        
        {showProgress && (
          <VideoProgressBar
            videoKey={videoKey}
            onReady={handleProgressReady}
          />
        )}
        
        <EbuR128Monitor
          videoKey={videoKey}
          currentTime={currentTime}
          isPlaying={isPlaying}
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
        <button className="btn" onClick={stepBackward} title="Step backward one frame">
          ⏮️
        </button>
        
        <button className="btn" onClick={togglePlayPause} disabled={isBuffering && !isPlaying}>
          {isBuffering && !isPlaying ? '⏳' : (isPlaying ? '⏸️' : '▶️')}
        </button>
        
        <button className="btn" onClick={stepForward} title="Step forward one frame">
          ⏭️
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
        
        {/* Audio Track Selection */}
        {availableAudioTracks.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.8rem', color: '#888' }}>Audio:</span>
            <select
              value={activeAudioTrack?.index || 0}
              onChange={(e) => switchAudioTrack(parseInt(e.target.value))}
              style={{
                backgroundColor: '#3a3a3a',
                color: '#fff',
                border: '1px solid #555',
                borderRadius: '3px',
                padding: '0.25rem',
                fontSize: '0.8rem'
              }}
            >
              {availableAudioTracks.map((track, index) => (
                <option key={index} value={track.index}>
                  {track.name} {track.language ? `(${track.language})` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        
        
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {/* Keyboard shortcuts help */}
          <div style={{ fontSize: '0.7rem', color: '#666', textAlign: 'right' }}>
            <div>← → , . : Frame step</div>
            <div>Space, K: Play/Pause • J/L: Skip ±10s • M: Mute</div>
          </div>
          
          {videoInfo && (
            <div style={{ fontSize: '0.8rem', color: '#888', borderLeft: '1px solid #444', paddingLeft: '1rem' }}>
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
          ⏳ Buffering... ({loadedFragments}/{expectedFragments} chunks loaded)
        </div>
      )}

    </div>
  );
}

export default VideoPlayer;