/**
 * map.ruiduobao.com - 模块化重构版
 *
 * 功能:
 * 1. 多年份省/市/县数据支持
 * 2. 村级数据按编码匹配
 * 3. 行政区划搜索功能
 * 4. 多格式矢量导出
 * 5. 统一错误处理
 * 6. 结构化日志
 *
 * 版本: 3.7.0
 * 更新时间: 2026-03-18
 */

// 加载环境变量
require('dotenv').config();

// 捕获未处理的Promise拒绝
require('express-async-errors');

const express = require('express');
const bodyParser = require('body-parser');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

// 配置
const { config, validateConfig } = require('./config');

// 日志
const { logger } = require('./utils/logger');

// 中间件
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const requestLogger = require('./middleware/requestLogger');

// 服务
const { initRedis } = require('./services/cache');
const preloadedData = require('./utils/preloadedData');
const vectorCache = require('./services/vectorCache');

// 路由
const indexRoutes = require('./routes/index');
const treeRoutes = require('./routes/tree');
const vectorRoutes = require('./routes/vector');
const searchRoutes = require('./routes/search');
const downloadRoutes = require('./routes/download');

// 创建应用
const app = express();

// ================== 中间件配置 ==================

// 信任代理
app.set('trust proxy', true);

// Gzip压缩
app.use(compression({
    filter: (req, res) => !req.headers['x-no-compression'] && compression.filter(req, res),
    threshold: 0,
    level: 6
}));

// 请求日志
app.use(requestLogger);

// 请求体解析
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: '50mb' }));

// 静态文件（vectordata 加 1 天缓存，其他默认）
app.use('/vectordata', express.static(path.join(__dirname, 'public/vectordata'), {
    maxAge: '1d',
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=86400');
    }
}));
app.use('/pics', express.static(path.join(__dirname, 'public/pics'), {
    maxAge: '7d',
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=604800');
    }
}));
app.use(express.static(path.join(__dirname, 'public')));

// 模板引擎
app.set('view engine', 'ejs');

// ================== 路由配置 ==================

// 基础路由
app.use('/', indexRoutes);

// API路由
app.use('/api/tree', treeRoutes);
app.use('/getGsonDB', vectorRoutes);
app.use('/getCunAddress', vectorRoutes);
app.use('/search', searchRoutes);
app.use('/downloadVector', downloadRoutes);
app.use('/downloadCountyBatch', downloadRoutes);
app.use('/downloadCityBatch', downloadRoutes);
app.use('/downloadTownBatch', downloadRoutes);
app.use('/downloadVillageBatch', downloadRoutes);

// ================== 兼容旧路由 ==================

// 静态矢量文件
app.get('/getGsonFile', (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('code is required');
    res.sendFile(path.join(__dirname, 'public/vectordata', `${code}.gson`));
});

// 缓存状态端点（运营查信）
app.get('/api/cache-status', (req, res) => {
    try {
        const stats = vectorCache.getCacheStats();
        const cacheDir = path.join(__dirname, 'cache');
        let cacheSizeMB = 0, cacheFiles = 0;
        if (fs.existsSync(cacheDir)) {
            cacheFiles = fs.readdirSync(cacheDir).filter(f => !fs.statSync(path.join(cacheDir, f)).isDirectory()).length;
            try {
                const { execSync } = require('child_process');
                const out = execSync(`du -sm ${cacheDir} 2>/dev/null | awk '{print $1}'`).toString().trim();
                cacheSizeMB = parseInt(out) || 0;
            } catch { cacheSizeMB = 0; }
        }
        res.json({
            success: true,
            vectordata: {
                fileCount: stats.fileCount,
                sizeMB: Math.round(stats.totalSizeMB * 10) / 10,
                maxFiles: config.village?.cache?.maxFiles,
                maxSizeMB: config.village?.cache?.maxSizeMB
            },
            appCache: {
                fileCount: cacheFiles,
                sizeMB: cacheSizeMB
            },
            totalMB: Math.round((stats.totalSizeMB + cacheSizeMB) * 10) / 10,
            budgetMB: 2048,
            usedPercent: Math.round(((stats.totalSizeMB + cacheSizeMB) / 2048) * 1000) / 10,
            timestamp: Date.now()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 反爬虫检查
app.get('/checkDownloadStatus', (req, res) => {
    res.json({ count: 0, needPassword: false, isBanned: false, banEndTime: null });
});

// 密码验证
app.post('/verifyPassword', (req, res) => {
    const { password } = req.body;
    if (password === config.auth.password) {
        return res.json({ success: true, message: '验证成功' });
    }
    res.status(401).json({ success: false, message: '密码错误' });
});

// 用户上传边界
app.post('/api/upload-boundary', (req, res) => {
    const { name, geojson, description } = req.body;
    if (!geojson) return res.status(400).json({ status: 'error', message: '需要GeoJSON数据' });

    const boundaryId = require('crypto').randomBytes(8).toString('hex');
    const filename = `custom_${boundaryId}.gson`;
    const filepath = path.join(__dirname, 'public/vectordata', filename);

    fs.writeFileSync(filepath, JSON.stringify(typeof geojson === 'string' ? JSON.parse(geojson) : geojson, null, 2));

    res.json({
        status: 'success',
        message: '边界上传成功',
        data: { id: boundaryId, name: name || `自定义边界_${boundaryId}`, filepath: `/vectordata/${filename}` }
    });
});

// 统计API
app.get('/api/statistics', async (req, res) => {
    const year = parseInt(req.query.year) || 2023;
    try {
        const stats = await getStatistics(year);
        res.json({ status: 'success', data: stats });
    } catch (err) {
        logger.error('获取统计失败: %s', err.message);
        res.status(500).json({ status: 'error', message: '获取统计数据失败' });
    }
});

// 历史变化API
app.get('/api/history', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).json({ status: 'error', message: '需要区划码' });

    try {
        const history = await getHistory(code);
        res.json({ status: 'success', data: history });
    } catch (err) {
        logger.error('获取历史失败: %s', err.message);
        res.status(500).json({ status: 'error', message: '获取历史数据失败' });
    }
});

// 下载统计API
app.get('/api/download-stats', (req, res) => {
    const password = req.query.password;
    if (password !== config.auth.password) {
        return res.status(403).json({ error: '密码错误' });
    }
    res.json({ total: 0, today: 0, records: [] });
});

// ================== 错误处理 ==================

// 404处理
app.use(notFoundHandler);

// 全局错误处理
app.use(errorHandler);

// ================== 启动服务 ==================

async function startServer() {
    try {
        // 验证配置
        validateConfig();
        logger.info('配置验证完成');

        // 初始化Redis
        await initRedis();

        // 预加载数据（只预加载必要的省级索引，村级索引采用懒加载）
        preloadedData.preloadAll();

        // 确保缓存目录存在
        const cacheDir = path.join(__dirname, 'public/vectordata');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        // 启动时清理过期的矢量缓存
        try {
            const result = vectorCache.cleanupVectorCache();
            if (result.removed > 0) {
                logger.info(`启动清理: 移除 ${result.removed} 个过期矢量文件`);
            }
            const stats = vectorCache.getCacheStats();
            logger.info(`矢量缓存状态: ${stats.fileCount} 个文件, ${stats.totalSizeMB.toFixed(1)} MB`);
        } catch (err) {
            logger.warn(`启动清理失败: ${err.message}`);
        }

        // 定时清理（每小时）
        setInterval(() => {
            try {
                vectorCache.cleanupVectorCache();
            } catch (err) {
                logger.warn('定时清理失败: %s', err.message);
            }
        }, 60 * 60 * 1000);

        // 启动服务
        app.listen(config.server.port, () => {
            logger.info('========================================');
            logger.info(`服务启动成功: http://localhost:${config.server.port}`);
            logger.info(`环境: ${config.server.nodeEnv}`);
            logger.info(`可用年份: ${config.availableYears.join(', ')}`);
            logger.info('========================================');
        });

    } catch (err) {
        logger.error('服务启动失败: %s', err.message);
        process.exit(1);
    }
}

// ================== 辅助函数 ==================

async function getStatistics(year) {
    const { queryOne } = require('./services/database');
    const stats = { year, provinces: 0, cities: 0, counties: 0, villages: 0 };

    try { stats.provinces = parseInt((await queryOne(`SELECT COUNT(*) as count FROM "SHENG"."CHN_sheng_${year}"`))?.count || 0); } catch (e) {}
    try { stats.cities = parseInt((await queryOne(`SELECT COUNT(*) as count FROM "SHI"."CHN_shi_${year}"`))?.count || 0); } catch (e) {}
    try { stats.counties = parseInt((await queryOne(`SELECT COUNT(*) as count FROM "XIAN"."CHN_xian_${year}"`))?.count || 0); } catch (e) {}
    try { stats.villages = parseInt((await queryOne(`SELECT COUNT(*) as count FROM "CUN"."chinacunpoint"`))?.count || 0); } catch (e) {}

    return stats;
}

async function getHistory(code) {
    const { queryOne } = require('./services/database');
    const history = [];

    for (const year of config.availableYears) {
        let data = null;
        try {
            if (/^\d{2}0000$/.test(code)) {
                data = await queryOne(`SELECT "省" as name, first_gid as code FROM "SHENG"."CHN_sheng_${year}" WHERE first_gid = $1`, [code]);
            } else if (/^\d{4}00$/.test(code)) {
                data = await queryOne(`SELECT "地名" as name, "区划码" as code FROM "SHI"."CHN_shi_${year}" WHERE code = $1`, [code]);
            } else if (/^\d{6}$/.test(code)) {
                data = await queryOne(`SELECT "地名" as name, "区划码" as code FROM "XIAN"."CHN_xian_${year}" WHERE code = $1`, [code]);
            }
        } catch (e) {}

        history.push({ year, exists: data !== null, data });
    }

    return history;
}

// 进程事件处理
process.on('uncaughtException', (err) => {
    logger.error('未捕获异常: %s', err.stack || err.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的Promise拒绝: %s', reason);
});

// 启动
startServer();

module.exports = app;