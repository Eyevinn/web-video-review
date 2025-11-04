import axios from 'axios';

const API_BASE = process.env.REACT_APP_API_URL || '/api';

class ApiService {
  constructor() {
    this.client = axios.create({
      baseURL: API_BASE,
      timeout: 30000,
    });
  }

  async getVideos(prefix = '', filters = {}) {
    try {
      const params = { prefix, ...filters };
      
      // Remove empty/undefined values
      Object.keys(params).forEach(key => {
        if (params[key] === undefined || params[key] === null || params[key] === '') {
          delete params[key];
        }
      });
      
      const response = await this.client.get('/s3/videos', { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching videos:', error);
      throw new Error(error.response?.data?.error || 'Failed to fetch videos');
    }
  }

  async getVideoInfo(videoKey) {
    try {
      const response = await this.client.get(`/video/${encodeURIComponent(videoKey)}/info`, {
        timeout: 120000
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching video info:', error);
      throw new Error(error.response?.data?.error || 'Failed to fetch video info');
    }
  }

  async getVideoMetadata(videoKey) {
    try {
      const response = await this.client.get(`/s3/video/${encodeURIComponent(videoKey)}/metadata`);
      return response.data;
    } catch (error) {
      console.error('Error fetching video metadata:', error);
      throw new Error(error.response?.data?.error || 'Failed to fetch video metadata');
    }
  }

  getVideoStreamUrl(videoKey, startTime = 0, duration = null) {
    const params = new URLSearchParams({ t: startTime });
    if (duration) {
      params.append('d', duration);
    }
    return `${API_BASE}/video/${encodeURIComponent(videoKey)}/stream?${params}`;
  }

  getVideoSeekUrl(videoKey, seekTime = 0, duration = 30) {
    const params = new URLSearchParams({ t: seekTime, d: duration });
    return `${API_BASE}/video/${encodeURIComponent(videoKey)}/seek?${params}`;
  }

  getHLSPlaylistUrl(videoKey, segmentDuration = 10) {
    const params = new URLSearchParams({ segmentDuration });
    return `${API_BASE}/video/${encodeURIComponent(videoKey)}/playlist.m3u8?${params}`;
  }

  getThumbnailUrl(videoKey, time = 0) {
    const params = new URLSearchParams({ t: time });
    return `${API_BASE}/video/${encodeURIComponent(videoKey)}/thumbnail?${params}`;
  }

  async getThumbnails(videoKey, count = 10, segmentDuration = 10) {
    try {
      const response = await this.client.get(`/video/${encodeURIComponent(videoKey)}/thumbnails`, {
        params: { count, segmentDuration }
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching thumbnails:', error);
      throw new Error(error.response?.data?.error || 'Failed to fetch thumbnails');
    }
  }

  async getWaveform(videoKey, segmentDuration = 10, samples = 1000) {
    try {
      const response = await this.client.get(`/video/${encodeURIComponent(videoKey)}/waveform`, {
        params: { segmentDuration, samples },
        timeout: 60000 // 60 second timeout for waveform generation
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching waveform:', error);
      throw new Error(error.response?.data?.error || 'Failed to fetch waveform');
    }
  }

  async getVideoProgress(videoKey) {
    try {
      const response = await this.client.get(`/video/${encodeURIComponent(videoKey)}/progress`);
      return response.data;
    } catch (error) {
      console.error('Error fetching video progress:', error);
      throw new Error(error.response?.data?.error || 'Failed to fetch video progress');
    }
  }

  async getSignedUrl(videoKey, expires = 3600) {
    try {
      const response = await this.client.get(`/s3/video/${encodeURIComponent(videoKey)}/url`, {
        params: { expires }
      });
      return response.data.url;
    } catch (error) {
      console.error('Error getting signed URL:', error);
      throw new Error(error.response?.data?.error || 'Failed to get signed URL');
    }
  }
}

// eslint-disable-next-line import/no-anonymous-default-export
export default new ApiService();