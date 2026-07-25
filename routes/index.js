/**
 * 主页和基础路由
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const ApiResponse = require('../utils/response');

// 获取项目根目录的绝对路径
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * 主页
 */
router.get('/', (req, res) => {
    res.render('index', { config, latitude: 35, longitude: 108 });
});

/**
 * 健康检查
 */
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: Date.now()
    });
});

/**
 * 获取年份列表
 */
router.get('/get-years', (req, res) => {
    res.json(['2023年', '2021年', '2018年', '2017年', '2010年']);
});

/**
 * 获取某年份的省份列表
 */
router.get('/get-provinces/:year', (req, res) => {
    const yearDir = decodeURIComponent(req.params.year);
    const yearPath = path.join(PROJECT_ROOT, 'year', yearDir);

    if (!fs.existsSync(yearPath)) {
        return res.json([]);
    }

    const provinces = fs.readdirSync(yearPath)
        .filter(file => file.endsWith('.html'))
        .map(file => file.replace('.html', ''));

    res.json(provinces);
});

module.exports = router;