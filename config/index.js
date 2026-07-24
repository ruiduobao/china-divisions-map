/**
 * 应用配置模块
 * 从环境变量加载配置，提供默认值
 */

require('dotenv').config();

const config = {
    // 服务器配置
    server: {
        port: parseInt(process.env.PORT) || 3003,
        nodeEnv: process.env.NODE_ENV || 'development'
    },

    // 数据库配置
    database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'shengshixian',
        user: process.env.DB_USER || 'ruiduobao',
        password: process.env.DB_PASSWORD || '',
        // 连接池配置
        max: parseInt(process.env.DB_MAX_CONNECTIONS) || 20,
        min: parseInt(process.env.DB_MIN_CONNECTIONS) || 2,
        idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
        connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 5000
    },

    // Redis配置
    redis: {
        enabled: process.env.REDIS_ENABLED === 'true',
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        ttl: parseInt(process.env.REDIS_TTL) || 3600
    },

    // 高德地图API
    gaode: {
        apiKey: process.env.GAODE_API_KEY || '',
        geocodeKey: process.env.GAODE_GEOCODE_KEY || ''
    },

    // 认证
    auth: {
        password: process.env.AUTH_PASSWORD || '55555'
    },

    // 缓存配置
    cache: {
        expiryDays: parseInt(process.env.CACHE_EXPIRY_DAYS) || 90,
        treeCacheTTL: parseInt(process.env.TREE_CACHE_TTL) || 86400000, // 24小时
        treeCacheMaxSize: parseInt(process.env.TREE_CACHE_MAX_SIZE) || 500,
        treeCacheMaxMemoryMB: parseInt(process.env.TREE_CACHE_MAX_MEMORY_MB) || 200
    },

    // 下载限制
    download: {
        limit: parseInt(process.env.DOWNLOAD_LIMIT) || 200000000,
        banDurationMinutes: parseInt(process.env.BAN_DURATION_MINUTES) || 30
    },

    // 可用年份
    availableYears: [2023, 2021, 2018, 2017, 2010],

    // 村级数据配置
    village: {
        // 是否启用村级面数据（true = 启用面数据，false = 只使用点数据）
        // 注意：与开发指南对齐，**默认禁用**，需要时再开
        enablePolygon: process.env.ENABLE_VILLAGE_POLYGON === 'true' || false,
        // 加载模式：point（点数据）/ polygon（面数据）/ auto（优先面，回退点）
        loadMode: process.env.VILLAGE_LOAD_MODE || 'point',
        // 批量下载模式：point（仅点）/ point_plus_xian（点+乡镇+县级批量包）
        // 前端在"村级下载"复选框里给用户选
        downloadMode: process.env.VILLAGE_DOWNLOAD_MODE || 'point_plus_xian',
        // 矢量缓存配置
        cache: {
            maxFiles: parseInt(process.env.VECTORDATA_MAX_FILES) || 50000,
            maxSizeMB: parseInt(process.env.VECTORDATA_MAX_SIZE_MB) || 1500
        }
    },

    // 热点省份
    hotProvinces: [
        '四川省', '广东省', '山东省', '河南省', '江苏省',
        '浙江省', '湖北省', '湖南省', '河北省', '安徽省'
    ]
};

// 配置验证
function validateConfig() {
    const errors = [];

    if (!config.database.password) {
        errors.push('DB_PASSWORD is required');
    }
    if (!config.gaode.apiKey) {
        errors.push('GAODE_API_KEY is required');
    }

    if (errors.length > 0) {
        console.warn('Configuration warnings:', errors.join(', '));
    }

    return errors.length === 0;
}

module.exports = { config, validateConfig };