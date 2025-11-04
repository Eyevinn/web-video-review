import React, { useEffect, useRef } from 'react';

function WaveformDisplay({ waveformData, width, height, currentTime, duration, onSeek }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!waveformData || !waveformData.samples || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // Set canvas resolution for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    
    // Clear canvas
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, 0, width, height);
    
    if (!waveformData.hasAudio) {
      // Display "No Audio" message
      ctx.fillStyle = '#666';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No Audio Track', width / 2, height / 2);
      return;
    }
    
    const samples = waveformData.samples;
    const sampleWidth = width / samples.length;
    const centerY = height / 2;
    const maxAmplitude = height / 2 - 2; // Leave some padding
    
    // Draw waveform
    ctx.fillStyle = '#4a9eff';
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 1;
    
    for (let i = 0; i < samples.length; i++) {
      const x = i * sampleWidth;
      const amplitude = samples[i] * maxAmplitude;
      
      // Draw vertical line representing amplitude
      ctx.fillRect(x, centerY - amplitude, Math.max(1, sampleWidth - 1), amplitude * 2);
    }
    
    // Draw current time indicator
    if (duration > 0) {
      const progressPercentage = (currentTime / duration) * 100;
      const progressX = (progressPercentage / 100) * width;
      
      // Draw progress overlay
      ctx.fillStyle = 'rgba(59, 130, 246, 0.3)';
      ctx.fillRect(0, 0, progressX, height);
      
      // Draw current time line
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(progressX, 0);
      ctx.lineTo(progressX, height);
      ctx.stroke();
    }
    
  }, [waveformData, width, height, currentTime, duration]);

  const handleClick = (e) => {
    if (!onSeek || !duration) return;
    
    const rect = canvasRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const newTime = percentage * duration;
    
    onSeek(Math.max(0, Math.min(newTime, duration)));
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      style={{
        cursor: onSeek ? 'pointer' : 'default',
        display: 'block'
      }}
      title={waveformData?.hasAudio ? 'Click to seek' : 'No audio track available'}
    />
  );
}

export default WaveformDisplay;