import React, { useState, useEffect } from 'react';

function VideoFilters({ onFiltersChange, currentFilters }) {
  const [filters, setFilters] = useState({
    search: '',
    fileType: '',
    minSize: '',
    maxSize: '',
    dateFrom: '',
    dateTo: '',
    sortBy: 'name',
    sortOrder: 'asc',
    ...currentFilters
  });

  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    setFilters(prev => ({ ...prev, ...currentFilters }));
  }, [currentFilters]);

  const handleFilterChange = (key, value) => {
    const newFilters = { ...filters, [key]: value };
    setFilters(newFilters);
    
    // Debounce search input
    if (key === 'search') {
      clearTimeout(window.searchTimeout);
      window.searchTimeout = setTimeout(() => {
        onFiltersChange(newFilters);
      }, 300);
    } else {
      onFiltersChange(newFilters);
    }
  };

  const clearFilters = () => {
    const clearedFilters = {
      search: '',
      fileType: '',
      minSize: '',
      maxSize: '',
      dateFrom: '',
      dateTo: '',
      sortBy: 'name',
      sortOrder: 'asc'
    };
    setFilters(clearedFilters);
    onFiltersChange(clearedFilters);
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const hasActiveFilters = filters.search || filters.fileType || filters.minSize || filters.maxSize || filters.dateFrom || filters.dateTo || filters.sortBy !== 'name' || filters.sortOrder !== 'asc';

  return (
    <div style={{ 
      marginBottom: '1rem',
      backgroundColor: '#2a2a2a',
      borderRadius: '6px',
      border: '1px solid #3a3a3a'
    }}>
      {/* Search bar - always visible */}
      <div style={{ padding: '0.75rem' }}>
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            placeholder="Search videos..."
            value={filters.search}
            onChange={(e) => handleFilterChange('search', e.target.value)}
            style={{
              width: '100%',
              padding: '0.5rem 2.5rem 0.5rem 0.75rem',
              backgroundColor: '#1a1a1a',
              border: '1px solid #444',
              borderRadius: '4px',
              color: '#fff',
              fontSize: '0.9rem'
            }}
          />
          <span style={{
            position: 'absolute',
            right: '0.75rem',
            top: '50%',
            transform: 'translateY(-50%)',
            color: '#666',
            fontSize: '0.9rem'
          }}>
            🔍
          </span>
        </div>
        
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          marginTop: '0.5rem' 
        }}>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            style={{
              background: 'none',
              border: 'none',
              color: '#4a9eff',
              cursor: 'pointer',
              fontSize: '0.8rem',
              textDecoration: 'underline',
              padding: 0
            }}
          >
            {isExpanded ? 'Hide Filters' : 'Show Filters'} {isExpanded ? '▲' : '▼'}
          </button>
          
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              style={{
                background: 'none',
                border: '1px solid #666',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '0.7rem',
                padding: '0.25rem 0.5rem',
                borderRadius: '3px'
              }}
            >
              Clear All
            </button>
          )}
        </div>
      </div>

      {/* Advanced filters - collapsible */}
      {isExpanded && (
        <div style={{ 
          padding: '0 0.75rem 0.75rem 0.75rem',
          borderTop: '1px solid #3a3a3a'
        }}>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
            gap: '1rem',
            marginTop: '0.75rem'
          }}>
            {/* File Type Filter */}
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: '#ccc' }}>
                File Type
              </label>
              <select
                value={filters.fileType}
                onChange={(e) => handleFilterChange('fileType', e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.4rem',
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #444',
                  borderRadius: '4px',
                  color: '#fff',
                  fontSize: '0.8rem'
                }}
              >
                <option value="">All Types</option>
                <option value="mp4">MP4</option>
                <option value="mov">MOV</option>
                <option value="avi">AVI</option>
                <option value="mkv">MKV</option>
                <option value="mxf">MXF</option>
                <option value="ts">TS</option>
                <option value="m2ts">M2TS</option>
              </select>
            </div>

            {/* Size Range */}
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: '#ccc' }}>
                Min Size (MB)
              </label>
              <input
                type="number"
                placeholder="0"
                value={filters.minSize ? Math.round(filters.minSize / (1024 * 1024)) : ''}
                onChange={(e) => handleFilterChange('minSize', e.target.value ? parseInt(e.target.value) * 1024 * 1024 : '')}
                style={{
                  width: '100%',
                  padding: '0.4rem',
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #444',
                  borderRadius: '4px',
                  color: '#fff',
                  fontSize: '0.8rem'
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: '#ccc' }}>
                Max Size (MB)
              </label>
              <input
                type="number"
                placeholder="∞"
                value={filters.maxSize && filters.maxSize !== Number.MAX_SAFE_INTEGER ? Math.round(filters.maxSize / (1024 * 1024)) : ''}
                onChange={(e) => handleFilterChange('maxSize', e.target.value ? parseInt(e.target.value) * 1024 * 1024 : '')}
                style={{
                  width: '100%',
                  padding: '0.4rem',
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #444',
                  borderRadius: '4px',
                  color: '#fff',
                  fontSize: '0.8rem'
                }}
              />
            </div>

            {/* Date Range */}
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: '#ccc' }}>
                From Date
              </label>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => handleFilterChange('dateFrom', e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.4rem',
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #444',
                  borderRadius: '4px',
                  color: '#fff',
                  fontSize: '0.8rem'
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: '#ccc' }}>
                To Date
              </label>
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => handleFilterChange('dateTo', e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.4rem',
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #444',
                  borderRadius: '4px',
                  color: '#fff',
                  fontSize: '0.8rem'
                }}
              />
            </div>

            {/* Sort Options */}
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: '#ccc' }}>
                Sort By
              </label>
              <select
                value={filters.sortBy}
                onChange={(e) => handleFilterChange('sortBy', e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.4rem',
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #444',
                  borderRadius: '4px',
                  color: '#fff',
                  fontSize: '0.8rem'
                }}
              >
                <option value="name">Name</option>
                <option value="size">Size</option>
                <option value="date">Date Modified</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: '#ccc' }}>
                Order
              </label>
              <select
                value={filters.sortOrder}
                onChange={(e) => handleFilterChange('sortOrder', e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.4rem',
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #444',
                  borderRadius: '4px',
                  color: '#fff',
                  fontSize: '0.8rem'
                }}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default VideoFilters;