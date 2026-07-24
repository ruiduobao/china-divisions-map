/**
 * 缓存服务模块
 * 整合 Redis 和内存缓存
 */

const redis = require('redis');
const { LRUCache } = require('lru-cache');
const { config } = require('../config');
const { logger } = require('../utils/logger');

// Redis 客户端
let redisClient = null;

// 内存缓存 (LRU)
const memoryCache = new LRUCache({
    max: config.cache.treeCacheMaxSize,
    ttl: config.cache.treeCacheTTL,
    maxSize: config.cache.treeCacheMaxMemoryMB * 1024 * 1024,
    sizeCalculation: (value) => {
        try {
            return JSON.stringify(value).length;
        } catch {
            return 1000;
        }
    }
});

/**
 * 初始化 Redis 连接
 */
async function initRedis() {
    if (!config.redis.enabled) {
        logger.info('Redis 已禁用，仅使用内存缓存');
        return;
    }

    try {
        redisClient = redis.createClient({ url: config.redis.url });
        redisClient.on('error', (err) => logger.error('Redis错误: %s', err.message));
        await redisClient.connect();
        logger.info('Redis 连接成功');
    } catch (err) {
        logger.warn('Redis 连接失败，将使用内存缓存: %s', err.message);
        redisClient = null;
    }
}

/**
 * 获取缓存
 */
async function get(key) {
    // 先查 Redis
    if (redisClient) {
        try {
            const data = await redisClient.get(key);
            if (data) {
                logger.debug({ key }, 'Redis缓存命中');
                return { data: JSON.parse(data), source: 'redis' };
            }
        } catch (err) {
            logger.warn('Redis读取失败: %s', err.message);
        }
    }

    // 再查内存缓存
    const memData = memoryCache.get(key);
    if (memData !== undefined) {
        logger.debug({ key }, '内存缓存命中');
        return { data: memData, source: 'memory' };
    }

    return null;
}

/**
 * 设置缓存
 */
async function set(key, data, ttl = config.redis.ttl) {
    // 存入内存缓存
    memoryCache.set(key, data);

    // 存入 Redis
    if (redisClient) {
        try {
            await redisClient.setEx(key, ttl, JSON.stringify(data));
        } catch (err) {
            logger.warn('Redis写入失败: %s', err.message);
        }
    }
}

/**
 * 删除缓存
 */
async function del(key) {
    memoryCache.delete(key);

    if (redisClient) {
        try {
            await redisClient.del(key);
        } catch (err) {
            logger.warn('Redis删除失败: %s', err.message);
        }
    }
}

/**
 * 清空所有缓存
 */
async function clear() {
    memoryCache.clear();

    if (redisClient) {
        try {
            await redisClient.flushDb();
        } catch (err) {
            logger.warn('Redis清空失败: %s', err.message);
        }
    }
}

/**
 * 获取缓存统计
 */
function getStats() {
    return {
        memory: {
            size: memoryCache.size,
            calculatedSize: memoryCache.calculatedSize,
            max: memoryCache.max,
            maxSize: memoryCache.maxSize
        },
        redis: {
            connected: redisClient !== null && redisClient.isOpen
        }
    };
}

module.exports = {
    initRedis,
    get,
    set,
    del,
    clear,
    getStats,
    memoryCache
};