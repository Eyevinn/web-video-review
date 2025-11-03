const AWS = require('aws-sdk');

class S3Service {
  constructor() {
    this.s3 = new AWS.S3({
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      region: process.env.S3_REGION,
      s3ForcePathStyle: true,
      signatureVersion: 'v4'
    });
    this.bucket = process.env.S3_BUCKET;
  }

  async listVideos(prefix = '') {
    try {
      const params = {
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: 1000
      };
      
      const data = await this.s3.listObjectsV2(params).promise();
      
      const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.mxf', '.ts', '.m2ts'];
      
      return data.Contents
        .filter(obj => {
          const ext = obj.Key.toLowerCase().substring(obj.Key.lastIndexOf('.'));
          return videoExtensions.includes(ext);
        })
        .map(obj => ({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified,
          filename: obj.Key.split('/').pop()
        }));
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