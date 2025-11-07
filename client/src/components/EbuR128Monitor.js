import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';

const EbuR128Monitor = ({ videoKey, currentTime, isPlaying, className = '' }) => {
  const [measurements, setMeasurements] = useState({
    integrated: null,
    range: null,
    lraLow: null,
    lraHigh: null,
    threshold: null
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isFirstLoad, setIsFirstLoad] = useState(true);
  const [hasStartedPlaying, setHasStartedPlaying] = useState(false);
  const currentTimeRef = useRef(currentTime);

  // Update ref when currentTime changes
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  // Reset hasStartedPlaying when video changes
  useEffect(() => {
    setHasStartedPlaying(false);
  }, [videoKey]);

  // Stable fetch function using ref for current time
  const fetchMeasurements = useCallback(async () => {
    if (!videoKey || !isPlaying) return;
    
    const shouldShowLoading = isFirstLoad || (measurements.integrated === null && measurements.range === null);
    if (shouldShowLoading) {
      setIsLoading(true);
    }
    setError(null);
    
    try {
      // Use current time from ref minus 5 seconds for a 10-second window ending near current position
      const currentVideoTime = currentTimeRef.current;
      const startTime = Math.max(0, currentVideoTime - 5);
      const duration = 10;
      
      console.log(`[EBU R128] Analyzing ${startTime.toFixed(1)}s - ${(startTime + duration).toFixed(1)}s (current: ${currentVideoTime.toFixed(1)}s)`);
      
      const result = await api.getEbuR128Analysis(videoKey, startTime, duration);
      setMeasurements(result);
      if (isFirstLoad) {
        setIsFirstLoad(false);
      }
    } catch (err) {
      console.error('Error fetching EBU R128 measurements:', err);
      setError('Failed to analyze audio');
    } finally {
      if (shouldShowLoading) {
        setIsLoading(false);
      }
    }
  }, [videoKey, isPlaying, isFirstLoad, measurements.integrated, measurements.range]);

  // Track when playback has started
  useEffect(() => {
    if (isPlaying && !hasStartedPlaying) {
      setHasStartedPlaying(true);
    }
  }, [isPlaying, hasStartedPlaying]);

  // Update measurements every 5 seconds when playing
  useEffect(() => {
    if (!isPlaying) {
      setIsFirstLoad(true); // Reset first load when playback stops
      return;
    }

    // Fetch immediately when playback starts
    fetchMeasurements();

    // Set up interval to fetch every 5 seconds
    const interval = setInterval(fetchMeasurements, 5000);

    return () => clearInterval(interval);
  }, [isPlaying, fetchMeasurements]);

  const formatValue = (value, unit = 'LUFS') => {
    if (value === null || value === undefined) return 'N/A';
    return `${value.toFixed(1)} ${unit}`;
  };

  const getComplianceColor = (integrated) => {
    if (integrated === null || integrated === undefined) return '#666';
    
    // EBU R128 target is -23 LUFS with tolerance of ±1 LU
    if (integrated >= -24 && integrated <= -22) return '#4CAF50'; // Green - compliant
    if (integrated >= -26 && integrated <= -20) return '#FF9800'; // Orange - acceptable
    return '#F44336'; // Red - non-compliant
  };

  // Hide monitor until playback has started
  if (!hasStartedPlaying) {
    return null;
  }

  return (
    <div className={`ebu-r128-monitor ${className}`} style={{
      position: 'absolute',
      bottom: '120px',
      left: '20px',
      background: 'rgba(0, 0, 0, 0.8)',
      color: 'white',
      padding: '12px',
      borderRadius: '6px',
      fontSize: '12px',
      fontFamily: 'monospace',
      minWidth: '200px',
      zIndex: 1000
    }}>
      <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '14px' }}>
        EBU R128 Monitor
      </div>
      
      {error && (
        <div style={{ color: '#F44336', marginBottom: '8px' }}>
          {error}
        </div>
      )}
      
      {isLoading && (
        <div style={{ color: '#FFC107', marginBottom: '8px' }}>
          Analyzing...
        </div>
      )}
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Integrated:</span>
          <span style={{ color: getComplianceColor(measurements.integrated) }}>
            {formatValue(measurements.integrated)}
          </span>
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Range:</span>
          <span>{formatValue(measurements.range, 'LU')}</span>
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>LRA Low:</span>
          <span>{formatValue(measurements.lraLow)}</span>
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>LRA High:</span>
          <span>{formatValue(measurements.lraHigh)}</span>
        </div>
      </div>
      
      {!isPlaying && (
        <div style={{ 
          marginTop: '8px', 
          color: '#666', 
          fontSize: '11px',
          fontStyle: 'italic'
        }}>
          Play video to start monitoring
        </div>
      )}
    </div>
  );
};

export default EbuR128Monitor;