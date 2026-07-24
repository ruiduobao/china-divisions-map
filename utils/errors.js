/**
 * 自定义错误类
 */

// 基础应用错误
class AppError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = true;

        Error.captureStackTrace(this, this.constructor);
    }
}

// 资源未找到错误
class NotFoundError extends AppError {
    constructor(message = '资源不存在') {
        super(message, 404, 'NOT_FOUND');
    }
}

// 参数验证错误
class ValidationError extends AppError {
    constructor(message = '参数验证失败') {
        super(message, 400, 'VALIDATION_ERROR');
    }
}

// 未授权错误
class UnauthorizedError extends AppError {
    constructor(message = '未授权访问') {
        super(message, 401, 'UNAUTHORIZED');
    }
}

// 禁止访问错误
class ForbiddenError extends AppError {
    constructor(message = '禁止访问') {
        super(message, 403, 'FORBIDDEN');
    }
}

// 数据库错误
class DatabaseError extends AppError {
    constructor(message = '数据库操作失败') {
        super(message, 500, 'DATABASE_ERROR');
    }
}

// 外部服务错误
class ExternalServiceError extends AppError {
    constructor(message = '外部服务调用失败') {
        super(message, 502, 'EXTERNAL_SERVICE_ERROR');
    }
}

module.exports = {
    AppError,
    NotFoundError,
    ValidationError,
    UnauthorizedError,
    ForbiddenError,
    DatabaseError,
    ExternalServiceError
};