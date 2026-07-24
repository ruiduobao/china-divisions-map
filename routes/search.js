/**
 * 搜索路由
 */

const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { query } = require('../services/database');
const { config } = require('../config');
const { logger } = require('../utils/logger');

/**
 * 搜索行政区划 - 流式返回
 * GET /search?keyword={keyword}&province={province}&year={year}
 */
router.get('/', asyncHandler(async (req, res) => {
    const keyword = req.query.keyword;
    const province = req.query.province || '';
    const year = parseInt(req.query.year) || 2023;
    const limit = parseInt(req.query.limit) || 10;

    if (!keyword || keyword.trim().length < 1) {
        return res.status(400).json({ status: 'error', message: '请输入搜索关键词' });
    }

    const searchPattern = `%${keyword.trim()}%`;
    let totalResults = [];
    let hasProvinceResults = false;

    // 设置SSE响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendResult = (result) => {
        res.write(`data: ${JSON.stringify(result)}\n\n`);
    };

    try {
        // 搜索省内
        if (province) {
            // 搜索县级
            try {
                const sql = `SELECT "地名" as name, "区划码" as code, 'xian' as level,
                                    "县级" as county_name, "地级" as city_name, "省级" as province_name
                             FROM "XIAN"."CHN_xian_${year}"
                             WHERE "省级" = $1 AND ("地名" ILIKE $2 OR "区划码" LIKE $2)
                             LIMIT $3`;
                const xianResults = await query(sql, [province, searchPattern, limit]);
                for (const r of xianResults) {
                    sendResult({ type: 'result', data: r, scope: 'province' });
                    totalResults.push(r);
                    hasProvinceResults = true;
                }
            } catch (e) { }

            // 搜索村内
            if (totalResults.length < limit) {
                try {
                    const sql = `SELECT fullname as name, cuncode as code, 'cun' as level,
                                        sheng, shi, xian, xiang
                                 FROM "CUN"."chinacunpoint"
                                 WHERE sheng = $1 AND (fullname ILIKE $2 OR CAST(cuncode AS TEXT) LIKE $2)
                                 LIMIT $3`;
                    const cunResults = await query(sql, [province, searchPattern, limit]);
                    for (const r of cunResults) {
                        sendResult({ type: 'result', data: r, scope: 'province' });
                        totalResults.push(r);
                        hasProvinceResults = true;
                    }
                } catch (e) { }
            }
        }

        sendResult({ type: 'provinceDone', hasResults: hasProvinceResults });

        // 搜索全国
        if (totalResults.length < limit * 2) {
            // 搜索省级
            try {
                const sql = `SELECT "省" as name, "省级码" as code, 'sheng' as level
                             FROM "SHENG"."CHN_sheng_${year}"
                             WHERE "省" ILIKE $1 OR "省级码" LIKE $1
                             LIMIT $2`;
                const results = await query(sql, [searchPattern, limit]);
                for (const r of results) {
                    if (!totalResults.find(x => x.code === r.code)) {
                        sendResult({ type: 'result', data: r, scope: 'nationwide' });
                        totalResults.push(r);
                    }
                }
            } catch (e) { }

            // 搜索地级
            try {
                const sql = `SELECT "地名" as name, "区划码" as code, 'shi' as level,
                                    "地级" as city_name, "省级" as province_name
                             FROM "SHI"."CHN_shi_${year}"
                             WHERE "地名" ILIKE $1 OR "区划码" LIKE $1
                             LIMIT $2`;
                const results = await query(sql, [searchPattern, limit]);
                for (const r of results) {
                    if (!totalResults.find(x => x.code === r.code)) {
                        sendResult({ type: 'result', data: r, scope: 'nationwide' });
                        totalResults.push(r);
                    }
                }
            } catch (e) { }

            // 搜索县级
            try {
                const sql = `SELECT "地名" as name, "区划码" as code, 'xian' as level,
                                    "县级" as county_name, "地级" as city_name, "省级" as province_name
                             FROM "XIAN"."CHN_xian_${year}"
                             WHERE "地名" ILIKE $1 OR "区划码" LIKE $1
                             LIMIT $2`;
                const results = await query(sql, [searchPattern, limit]);
                for (const r of results) {
                    if (!totalResults.find(x => x.code === r.code)) {
                        sendResult({ type: 'result', data: r, scope: 'nationwide' });
                        totalResults.push(r);
                    }
                }
            } catch (e) { }

            // 搜索村级
            try {
                const sql = `SELECT fullname as name, cuncode as code, 'cun' as level,
                                    sheng, shi, xian, xiang
                             FROM "CUN"."chinacunpoint"
                             WHERE fullname ILIKE $1 OR CAST(cuncode AS TEXT) LIKE $1
                             LIMIT $2`;
                const results = await query(sql, [searchPattern, limit]);
                for (const r of results) {
                    if (!totalResults.find(x => x.code === r.code)) {
                        sendResult({ type: 'result', data: r, scope: 'nationwide' });
                        totalResults.push(r);
                    }
                }
            } catch (e) { }
        }

        sendResult({ type: 'done', total: totalResults.length });
        res.end();

    } catch (err) {
        logger.error('搜索失败: %s', err.message);
        sendResult({ type: 'error', message: '搜索失败' });
        res.end();
    }
}));

module.exports = router;