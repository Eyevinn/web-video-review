import React, { useState, useEffect } from 'react';
import api from '../services/api';

const MemoryMonitor = ({ className = '', collapsed = false }) => {
  const [memoryStats, setMemoryStats] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [isCollapsed, setIsCollapsed] = useState(collapsed);

  useEffect(() => {
    const fetchMemoryStats = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const response = await fetch('/api/video/memory-stats');
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        setMemoryStats(data.processes || []);
        setLastUpdate(new Date(data.timestamp));
      } catch (err) {
        console.error('Error fetching memory stats:', err);
        setError('Failed to fetch memory statistics');
        setMemoryStats([]);
      } finally {
        setIsLoading(false);
      }
    };

    // Fetch immediately
    fetchMemoryStats();
    
    // Fetch every 5 seconds
    const interval = setInterval(fetchMemoryStats, 5000);
    
    return () => clearInterval(interval);
  }, []);

  const formatUptime = (startTime) => {
    const uptime = Date.now() - startTime;
    const seconds = Math.floor(uptime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  const getProcessColor = (type) => {
    switch (type) {
      case 'HLS Generation': return '#3b82f6'; // Blue
      case 'EBU R128 Analysis': return '#10b981'; // Green
      case 'Waveform Generation': return '#f59e0b'; // Orange
      case 'Thumbnail Generation': return '#8b5cf6'; // Purple
      default: return '#6b7280'; // Gray
    }
  };

  const totalMemory = memoryStats.reduce((sum, process) => sum + process.memory.rss, 0);

  return (
    <div className={`memory-monitor ${className}`} style={{
      position: 'fixed',
      top: '20px',
      right: '20px',
      background: 'rgba(0, 0, 0, 0.9)',
      color: 'white',
      padding: isCollapsed ? '8px 12px' : '12px',
      borderRadius: '6px',
      fontSize: '11px',
      fontFamily: 'monospace',
      minWidth: isCollapsed ? '120px' : '300px',
      maxWidth: isCollapsed ? '120px' : '400px',
      zIndex: 2000,
      border: '1px solid rgba(255, 255, 255, 0.2)'
    }}>
      <div 
        style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          marginBottom: isCollapsed ? '0' : '8px',
          cursor: 'pointer'
        }}
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span style={{ fontWeight: 'bold', fontSize: '12px' }}>
          {isCollapsed ? 'FFmpeg' : 'FFmpeg Memory Monitor'}
        </span>
        <span style={{ fontSize: '10px', opacity: 0.7 }}>
          {isCollapsed ? '▼' : '▲'}
        </span>
      </div>
      
      {!isCollapsed && (
        <>
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            marginBottom: '8px',
            paddingBottom: '4px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.2)'
          }}>
            <span>Total: {api.formatBytes ? api.formatBytes(totalMemory) : `${(totalMemory / 1024 / 1024).toFixed(1)} MB`}</span>
            <span>Processes: {memoryStats.length}</span>
          </div>
          
          {error && (
            <div style={{ color: '#f87171', marginBottom: '8px', fontSize: '10px' }}>
              {error}
            </div>
          )}
          
          {isLoading && memoryStats.length === 0 && (
            <div style={{ color: '#fbbf24', marginBottom: '8px', fontSize: '10px' }}>
              Loading...
            </div>
          )}
          
          <div style={{ 
            maxHeight: '200px', 
            overflowY: 'auto',
            marginBottom: lastUpdate ? '8px' : '0'
          }}>
            {memoryStats.length === 0 && !isLoading ? (
              <div style={{ 
                color: '#6b7280', 
                fontStyle: 'italic', 
                textAlign: 'center',
                padding: '8px 0'
              }}>
                No active FFmpeg processes
              </div>
            ) : (
              memoryStats.map((process) => (
                <div 
                  key={process.key}
                  style={{
                    marginBottom: '6px',
                    padding: '4px',
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    borderRadius: '3px',
                    borderLeft: `3px solid ${getProcessColor(process.type)}`
                  }}
                >
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '2px'
                  }}>
                    <span style={{ 
                      fontSize: '10px', 
                      fontWeight: 'bold',
                      color: getProcessColor(process.type)
                    }}>
                      {process.type}
                    </span>
                    <span style={{ fontSize: '10px', opacity: 0.7 }}>
                      PID: {process.pid}
                    </span>
                  </div>
                  
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between',
                    fontSize: '10px'
                  }}>
                    <span>Memory: {process.memory.rssFormatted}</span>
                    <span>CPU: {process.cpu.toFixed(1)}%</span>
                  </div>
                  
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between',
                    fontSize: '9px',
                    opacity: 0.7,
                    marginTop: '2px'
                  }}>
                    <span>Video: {process.videoKey}</span>
                    <span>Uptime: {formatUptime(process.startTime)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
          
          {lastUpdate && (
            <div style={{ 
              fontSize: '9px', 
              color: '#6b7280',
              textAlign: 'center',
              borderTop: '1px solid rgba(255, 255, 255, 0.1)',
              paddingTop: '4px'
            }}>
              Updated: {lastUpdate.toLocaleTimeString()}
            </div>
          )}
        </>
      )}
      
      {isCollapsed && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
          <span>{memoryStats.length} proc</span>
          <span>{api.formatBytes ? api.formatBytes(totalMemory) : `${(totalMemory / 1024 / 1024).toFixed(0)}M`}</span>
        </div>
      )}
    </div>
  );
};

export default MemoryMonitor;