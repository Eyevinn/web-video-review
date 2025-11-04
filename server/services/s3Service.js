const AWS = require('aws-sdk');

class S3Service {
  constructor() {
    // Build S3 configuration
    const s3Config = {
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      region: process.env.S3_REGION,
      s3ForcePathStyle: true,
      signatureVersion: 'v4'
    };

    // Add session token if provided (for temporary credentials/IAM roles)
    if (process.env.AWS_SESSION_TOKEN) {
      s3Config.sessionToken = process.env.AWS_SESSION_TOKEN;
    }

    this.s3 = new AWS.S3(s3Config);
    this.bucket = process.env.S3_BUCKET;
    
    // Log configuration status (without sensitive details)
    console.log('[S3Service] Initialized with:', {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      bucket: this.bucket,
      hasAccessKey: !!process.env.S3_ACCESS_KEY_ID,
      hasSecretKey: !!process.env.S3_SECRET_ACCESS_KEY,
      hasSessionToken: !!process.env.AWS_SESSION_TOKEN,
      pathStyle: true
    });
  }

  async listVideos(prefix = '', filters = {}) {
    try {
      const {
        search = '',
        fileType = '',
        minSize = 0,
        maxSize = Number.MAX_SAFE_INTEGER,
        dateFrom = null,
        dateTo = null,
        sortBy = 'name',
        sortOrder = 'asc'
      } = filters;

      const params = {
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        Delimiter: '/' // This groups objects by common prefixes (folders)
      };
      
      const data = await this.s3.listObjectsV2(params).promise();
      
      const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.mxf', '.ts', '.m2ts'];
      const items = [];
      
      // Add folders (common prefixes) - folders are not filtered by search/file filters
      if (data.CommonPrefixes) {
        data.CommonPrefixes.forEach(commonPrefix => {
          const folderKey = commonPrefix.Prefix;
          const folderName = folderKey.slice(prefix.length).replace(/\/$/, '');
          
          if (folderName) {
            // Apply search filter to folder names
            if (!search || folderName.toLowerCase().includes(search.toLowerCase())) {
              items.push({
                key: folderKey,
                name: folderName,
                type: 'folder',
                size: 0,
                lastModified: null
              });
            }
          }
        });
      }
      
      // Add video files with filtering
      if (data.Contents) {
        data.Contents.forEach(obj => {
          // Skip the current folder itself (when prefix ends with /)
          if (obj.Key === prefix) return;
          
          const ext = obj.Key.toLowerCase().substring(obj.Key.lastIndexOf('.'));
          if (!videoExtensions.includes(ext)) return;
          
          const filename = obj.Key.split('/').pop();
          
          // Apply filters
          const matchesSearch = !search || filename.toLowerCase().includes(search.toLowerCase());
          const matchesFileType = !fileType || ext.slice(1) === fileType.toLowerCase();
          const matchesSize = obj.Size >= minSize && obj.Size <= maxSize;
          
          let matchesDate = true;
          if (dateFrom || dateTo) {
            const fileDate = new Date(obj.LastModified);
            if (dateFrom) {
              matchesDate = matchesDate && fileDate >= new Date(dateFrom);
            }
            if (dateTo) {
              const toDate = new Date(dateTo);
              toDate.setHours(23, 59, 59, 999); // Include the entire day
              matchesDate = matchesDate && fileDate <= toDate;
            }
          }
          
          if (matchesSearch && matchesFileType && matchesSize && matchesDate) {
            items.push({
              key: obj.Key,
              name: filename,
              type: 'file',
              size: obj.Size,
              lastModified: obj.LastModified,
              filename: filename, // Keep for backward compatibility
              extension: ext.slice(1)
            });
          }
        });
      }
      
      // Sort items
      items.sort((a, b) => {
        // Always sort folders first
        if (a.type !== b.type) {
          return a.type === 'folder' ? -1 : 1;
        }
        
        let comparison = 0;
        switch (sortBy) {
          case 'name':
            comparison = a.name.localeCompare(b.name);
            break;
          case 'size':
            comparison = (a.size || 0) - (b.size || 0);
            break;
          case 'date':
            const dateA = a.lastModified ? new Date(a.lastModified) : new Date(0);
            const dateB = b.lastModified ? new Date(b.lastModified) : new Date(0);
            comparison = dateA - dateB;
            break;
          default:
            comparison = a.name.localeCompare(b.name);
        }
        
        return sortOrder === 'desc' ? -comparison : comparison;
      });
      
      console.log(`[S3Service] Filtered ${items.length} items from S3 (search: "${search}", type: "${fileType}")`);
      return items;
    } catch (error) {
      console.error('Error listing videos:', error);
      throw error;
    }
  }

  async getVideoStream(key, range) {
    try {
      const params = {
        Bucket: this.bucket,
        Key: key
      };

      if (range) {
        params.Range = range;
      }

      return this.s3.getObject(params).createReadStream();
    } catch (error) {
      console.error('Error getting video stream:', error);
      throw error;
    }
  }

  async getVideoMetadata(key) {
    try {
      const params = {
        Bucket: this.bucket,
        Key: key
      };
      
      const headData = await this.s3.headObject(params).promise();
      
      return {
        size: headData.ContentLength,
        lastModified: headData.LastModified,
        contentType: headData.ContentType,
        etag: headData.ETag
      };
    } catch (error) {
      console.error('Error getting video metadata:', error);
      throw error;
    }
  }

  getSignedUrl(key, expires = 3600) {
    const params = {
      Bucket: this.bucket,
      Key: key,
      Expires: expires
    };
    
    return this.s3.getSignedUrl('getObject', params);
  }
}

module.exports = new S3Service();