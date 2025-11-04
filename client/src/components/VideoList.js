import React from 'react';
import VideoFilters from './VideoFilters';

function VideoList({ videos, selectedVideo, onVideoSelect, onRefresh, currentPath = '', onFolderNavigate, currentFilters, onFiltersChange }) {
  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString();
  };

  const handleItemClick = (item) => {
    if (item.type === 'folder') {
      onFolderNavigate && onFolderNavigate(item.key);
    } else {
      onVideoSelect(item);
    }
  };

  const getBreadcrumbs = () => {
    if (!currentPath) return [];
    const parts = currentPath.split('/').filter(Boolean);
    const breadcrumbs = [{ name: 'Root', path: '' }];
    
    let currentFullPath = '';
    parts.forEach(part => {
      currentFullPath += part + '/';
      breadcrumbs.push({ name: part, path: currentFullPath });
    });
    
    return breadcrumbs;
  };

  return (
    <div className="video-list">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h3>Video Files</h3>
        <button className="btn" onClick={onRefresh} style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}>
          Refresh
        </button>
      </div>
      
      {/* Filters */}
      <VideoFilters
        currentFilters={currentFilters}
        onFiltersChange={onFiltersChange}
      />
      
      {/* Breadcrumb navigation */}
      {(currentPath || getBreadcrumbs().length > 1) && (
        <div style={{ 
          marginBottom: '1rem', 
          padding: '0.5rem', 
          backgroundColor: '#2a2a2a', 
          borderRadius: '4px',
          fontSize: '0.9rem'
        }}>
          {getBreadcrumbs().map((crumb, index) => (
            <span key={crumb.path}>
              {index > 0 && <span style={{ margin: '0 0.5rem', color: '#666' }}>{'>'}</span>}
              <span
                style={{
                  color: index === getBreadcrumbs().length - 1 ? '#fff' : '#4a9eff',
                  cursor: index === getBreadcrumbs().length - 1 ? 'default' : 'pointer',
                  textDecoration: index === getBreadcrumbs().length - 1 ? 'none' : 'underline'
                }}
                onClick={() => index < getBreadcrumbs().length - 1 && onFolderNavigate && onFolderNavigate(crumb.path)}
              >
                {crumb.name}
              </span>
            </span>
          ))}
        </div>
      )}
      
      {videos.length === 0 ? (
        <div style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>
          <div>No video files found</div>
          <div style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
            Make sure your S3 credentials are configured correctly
          </div>
        </div>
      ) : (
        videos.map((item) => (
          <div
            key={item.key}
            className={`video-item ${selectedVideo?.key === item.key ? 'selected' : ''} ${item.type === 'folder' ? 'folder-item' : ''}`}
            onClick={() => handleItemClick(item)}
            style={{
              cursor: item.type === 'folder' ? 'pointer' : 'pointer',
              backgroundColor: item.type === 'folder' ? '#1a2332' : undefined
            }}
          >
            <div className="video-item-name">
              <span style={{ marginRight: '0.5rem' }}>
                {item.type === 'folder' ? '📁' : '🎬'}
              </span>
              {item.name}
            </div>
            <div className="video-item-info">
              <div>{item.type === 'folder' ? 'Folder' : formatFileSize(item.size)}</div>
              <div>{item.lastModified ? formatDate(item.lastModified) : ''}</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export default VideoList;