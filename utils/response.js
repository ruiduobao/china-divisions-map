/**
 * 统一API响应格式
 */

class ApiResponse {
    /**
     * 成功响应
     */
    static success(res, data = null, message = '操作成功', statusCode = 200) {
        return res.status(statusCode).json({
            status: 'success',
            code: statusCode,
            message,
            data,
            timestamp: Date.now()
        });
    }

    /**
     * 错误响应
     */
    static error(res, message = '操作失败', statusCode = 500, code = 'ERROR', details = null) {
        const response = {
            status: 'error',
            code: statusCode,
            error: {
                code,
                message
            },
            timestamp: Date.now()
        };

        if (details) {
            response.error.details = details;
        }

        return res.status(statusCode).json(response);
    }

    /**
     * 分页响应
     */
    static paginated(res, data, page, limit, total) {
        return res.status(200).json({
            status: 'success',
            code: 200,
            message: '操作成功',
            data,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            },
            timestamp: Date.now()
        });
    }

    /**
     * 无数据响应（用于删除等操作）
     */
    static noContent(res) {
        return res.status(204).send();
    }

    /**
     * 创建成功响应
     */
    static created(res, data, message = '创建成功') {
        return this.success(res, data, message, 201);
    }
}

module.exports = ApiResponse;