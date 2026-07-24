/**
 * 错误处理中间件
 */

const { logger } = require('../utils/logger');
const { AppError } = require('../utils/errors');
const ApiResponse = require('../utils/response');

/**
 * 404处理中间件
 */
function notFoundHandler(req, res, next) {
    const error = new Error(`路由不存在: ${req.originalUrl}`);
    error.statusCode = 404;
    error.code = 'NOT_FOUND';
    next(error);
}

/**
 * 全局错误处理中间件
 */
function errorHandler(err, req, res, next) {
    // 如果响应已经发送，跳过
    if (res.headersSent) {
        return next(err);
    }

    let statusCode = err.statusCode || 500;
    let errorCode = err.code || 'INTERNAL_ERROR';
    let message = err.message || '服务器内部错误';
    let details = null;

    // 处理特定错误类型
    if (err.name === 'ValidationError') {
        statusCode = 400;
        errorCode = 'VALIDATION_ERROR';
        details = err.details;
    }

    // 数据库错误
    if (err.code === '23505') {
        statusCode = 409;
        errorCode = 'DUPLICATE_ENTRY';
        message = '数据已存在';
    }

    // JWT错误
    if (err.name === 'JsonWebTokenError') {
        statusCode = 401;
        errorCode = 'INVALID_TOKEN';
        message = '无效的令牌';
    }

    if (err.name === 'TokenExpiredError') {
        statusCode = 401;
        errorCode = 'TOKEN_EXPIRED';
        message = '令牌已过期';
    }

    // 记录错误日志
    const logData = {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        statusCode,
        errorCode,
        message
    };

    if (statusCode >= 500) {
        logger.error(logData, '服务器错误: %s', err.stack || err.message);
    } else {
        logger.warn(logData, '客户端错误');
    }

    // 生产环境隐藏详细错误信息
    if (process.env.NODE_ENV === 'production' && statusCode >= 500) {
        message = '服务器内部错误';
        details = null;
    }

    return ApiResponse.error(res, message, statusCode, errorCode, details);
}

/**
 * 异步路由包装器
 * 自动捕获异步错误并传递给错误处理中间件
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = {
    notFoundHandler,
    errorHandler,
    asyncHandler
};