/**
 * 请求日志中间件
 */

const { logger } = require('../utils/logger');

function requestLogger(req, res, next) {
    const startTime = Date.now();

    // 请求开始日志
    logger.info({
        method: req.method,
        url: req.originalUrl,
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('user-agent')
    }, '请求开始');

    // 响应结束时记录耗时
    res.on('finish', () => {
        const duration = Date.now() - startTime;

        logger.info({
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            duration: `${duration}ms`
        }, '请求完成');
    });

    next();
}

module.exports = requestLogger;