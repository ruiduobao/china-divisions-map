/**
 * 树状数据API路由
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const iconv = require('iconv-lite');
const { asyncHandler } = require('../middleware/errorHandler');
const ApiResponse = require('../utils/response');
const cache = require('../services/cache');
const preloadedData = require('../utils/preloadedData');
const { config } = require('../config');
const { logger } = require('../utils/logger');

const CSV_DIR = path.join(__dirname, '../处理脚本/data/修改后的csv文件');
const PROVINCES_CACHE_DIR = path.join(__dirname, '../cache/provinces');

/**
 * 获取省份列表
 * GET /api/tree/provinces?year=2023
 */
router.get('/provinces', asyncHandler(async (req, res) => {
    const year = req.query.year || '2023';

    // 优先使用预加载数据
    const provinces = preloadedData.getProvinces(year);
    if (provinces.length > 0) {
        return ApiResponse.success(res, provinces, '获取省份列表成功');
    }

    // 回退到CSV读取
    const provinces2 = await loadProvincesFromCSV(year);
    return ApiResponse.success(res, provinces2, '获取省份列表成功');
}));

/**
 * 获取某省的城市列表
 * GET /api/tree/cities?year=2023&province=四川省
 */
router.get('/cities', asyncHandler(async (req, res) => {
    const year = req.query.year || '2023';
    const province = req.query.province;

    if (!province) {
        return ApiResponse.error(res, '需要省份参数', 400, 'MISSING_PARAM');
    }

    // 检查缓存
    const cacheKey = `cities_${year}_${province}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
        return ApiResponse.success(res, cached.data, '获取城市列表成功');
    }

    // 优先使用预加载数据
    const cities = preloadedData.getCities(year, province);
    if (cities.length > 0) {
        await cache.set(cacheKey, cities);
        return ApiResponse.success(res, cities, '获取城市列表成功');
    }

    // 回退到CSV读取
    const cities2 = await loadCitiesFromCSV(year, province);
    await cache.set(cacheKey, cities2);
    return ApiResponse.success(res, cities2, '获取城市列表成功');
}));

/**
 * 获取某市的县列表
 * GET /api/tree/counties?year=2023&province=四川省&city=成都市
 */
router.get('/counties', asyncHandler(async (req, res) => {
    const year = req.query.year || '2023';
    const { province, city } = req.query;

    if (!province || !city) {
        return ApiResponse.error(res, '需要省份和城市参数', 400, 'MISSING_PARAM');
    }

    // 检查缓存
    const cacheKey = `counties_${year}_${province}_${city}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
        return ApiResponse.success(res, cached.data, '获取县列表成功');
    }

    // 优先使用预加载数据
    const counties = preloadedData.getCounties(year, province, city);
    if (counties.length > 0) {
        await cache.set(cacheKey, counties);
        return ApiResponse.success(res, counties, '获取县列表成功');
    }

    // 回退到CSV读取
    const counties2 = await loadCountiesFromCSV(year, province, city);
    await cache.set(cacheKey, counties2);
    return ApiResponse.success(res, counties2, '获取县列表成功');
}));

/**
 * 获取某县的乡镇列表
 * GET /api/tree/towns?year=2023&province=四川省&city=成都市&county=锦江区
 */
router.get('/towns', asyncHandler(async (req, res) => {
    const year = req.query.year || '2023';
    const { province, city, county } = req.query;

    if (!province || !city || !county) {
        return ApiResponse.error(res, '需要省份、城市和县参数', 400, 'MISSING_PARAM');
    }

    // 检查缓存
    const cacheKey = `towns_${year}_${province}_${city}_${county}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
        return ApiResponse.success(res, cached.data, '获取乡镇列表成功');
    }

    // 优先使用预加载数据
    const towns = preloadedData.getTowns(year, province, city, county);
    if (towns.length > 0) {
        await cache.set(cacheKey, towns);
        return ApiResponse.success(res, towns, '获取乡镇列表成功');
    }

    // 回退到CSV读取
    const towns2 = await loadTownsFromCSV(year, province, city, county);
    await cache.set(cacheKey, towns2);
    return ApiResponse.success(res, towns2, '获取乡镇列表成功');
}));

/**
 * 获取某乡镇的村列表
 * GET /api/tree/villages?year=2023&province=四川省&city=成都市&county=锦江区&town=春熙路街道
 */
router.get('/villages', asyncHandler(async (req, res) => {
    const year = req.query.year || '2023';
    const { province, city, county, town } = req.query;

    if (!province || !city || !county || !town) {
        return ApiResponse.error(res, '需要省份、城市、县和乡镇参数', 400, 'MISSING_PARAM');
    }

    // 检查缓存
    const cacheKey = `villages_${year}_${province}_${city}_${county}_${town}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
        return ApiResponse.success(res, cached.data, '获取村列表成功');
    }

    // 优先使用预加载数据
    const villages = preloadedData.getVillages(year, province, city, county, town);
    if (villages.length > 0) {
        await cache.set(cacheKey, villages);
        return ApiResponse.success(res, villages, '获取村列表成功');
    }

    // 回退到CSV读取
    const villages2 = await loadVillagesFromCSV(year, province, city, county, town);
    await cache.set(cacheKey, villages2);
    return ApiResponse.success(res, villages2, '获取村列表成功');
}));

// ================== 预生成缓存文件读取 ==================

/**
 * 读取预生成的省份缓存文件
 */
function loadProvinceCacheFile(year, province) {
    const filename = `tree_${year}_${province}.json`;
    const filepath = path.join(PROVINCES_CACHE_DIR, filename);
    
    if (fs.existsSync(filepath)) {
        try {
            const data = fs.readFileSync(filepath, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            logger.warn('读取省份缓存文件失败: %s', err.message);
        }
    }
    return null;
}

/**
 * 获取完整树状数据
 * GET /api/tree/full?year=2023&province=四川省
 */
router.get('/full', asyncHandler(async (req, res) => {
    const year = req.query.year || '2023';
    const province = req.query.province;

    if (!province) {
        return ApiResponse.error(res, '需要省份参数', 400, 'MISSING_PARAM');
    }

    // 检查缓存
    const cacheKey = `full_${year}_${province}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
        return ApiResponse.success(res, cached.data, '获取树状数据成功');
    }

    // 1. 优先使用预生成的缓存文件
    const prebuiltTree = loadProvinceCacheFile(year, province);
    if (prebuiltTree) {
        await cache.set(cacheKey, prebuiltTree);
        logger.info('使用预生成缓存文件: tree_%s_%s.json', year, province);
        return ApiResponse.success(res, prebuiltTree, '获取树状数据成功');
    }

    // 2. 优先使用预加载数据
    const tree = preloadedData.getTree(year, province);
    if (tree) {
        await cache.set(cacheKey, tree);
        return ApiResponse.success(res, tree, '获取树状数据成功');
    }

    // 3. 回退到CSV读取
    const tree2 = await loadFullTreeFromCSV(year, province);
    await cache.set(cacheKey, tree2);
    return ApiResponse.success(res, tree2, '获取树状数据成功');
}));

/**
 * 预加载某省数据
 * GET /api/tree/preload?year=2023&province=四川省
 */
router.get('/preload', asyncHandler(async (req, res) => {
    const year = req.query.year || '2023';
    const province = req.query.province;

    if (!province) {
        return ApiResponse.error(res, '需要省份参数', 400, 'MISSING_PARAM');
    }

    const cacheKey = `full_${year}_${province}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
        return ApiResponse.success(res, null, '数据已缓存', 200);
    }

    // 加载完整树
    const tree = preloadedData.getTree(year, province) ||
        await loadFullTreeFromCSV(year, province);

    if (tree) {
        await cache.set(cacheKey, tree);
        return ApiResponse.success(res, { cities: tree.length }, '预加载完成');
    }

    return ApiResponse.error(res, '预加载失败', 500, 'PRELOAD_ERROR');
}));

// ================== CSV读取辅助函数 ==================

// 检查CSV文件是否存在
function csvFileExists(year) {
    const csvPath = path.join(CSV_DIR, `2.生成的数据位一到五级(含编码)${year}.csv`);
    return fs.existsSync(csvPath);
}

async function loadProvincesFromCSV(year) {
    const csvPath = path.join(CSV_DIR, `2.生成的数据位一到五级(含编码)${year}.csv`);

    if (!fs.existsSync(csvPath)) {
        logger.warn('CSV文件不存在: %s', csvPath);
        return [];
    }

    const provinces = new Map();

    return new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(iconv.decodeStream('utf8'))
            .pipe(csv())
            .on('data', (row) => {
                const sheng = row['省'];
                const code = row['编码'];
                if (sheng && !provinces.has(sheng)) {
                    const shengCode = code ? code.substring(0, 2) + '0000' : '';
                    provinces.set(sheng, { name: sheng, code: shengCode });
                }
            })
            .on('end', () => resolve(Array.from(provinces.values())))
            .on('error', (err) => {
                logger.error('读取CSV失败: %s', err.message);
                resolve([]);
            });
    });
}

async function loadCitiesFromCSV(year, province) {
    const csvPath = path.join(CSV_DIR, `2.生成的数据位一到五级(含编码)${year}.csv`);

    if (!fs.existsSync(csvPath)) {
        logger.warn('CSV文件不存在: %s', csvPath);
        return [];
    }

    const cities = new Map();

    return new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(iconv.decodeStream('utf8'))
            .pipe(csv())
            .on('data', (row) => {
                if (row['省'] === province) {
                    const shi = row['市'];
                    const code = row['编码'];
                    if (shi && shi.trim() && !cities.has(shi)) {
                        const shiCode = code ? code.substring(0, 4) + '00' : '';
                        cities.set(shi, { name: shi, code: shiCode, province });
                    }
                }
            })
            .on('end', () => resolve(Array.from(cities.values())))
            .on('error', (err) => {
                logger.error('读取CSV失败: %s', err.message);
                resolve([]);
            });
    });
}

async function loadCountiesFromCSV(year, province, city) {
    const csvPath = path.join(CSV_DIR, `2.生成的数据位一到五级(含编码)${year}.csv`);

    if (!fs.existsSync(csvPath)) {
        logger.warn('CSV文件不存在: %s', csvPath);
        return [];
    }

    const counties = new Map();

    return new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(iconv.decodeStream('utf8'))
            .pipe(csv())
            .on('data', (row) => {
                if (row['省'] === province && row['市'] === city) {
                    const xian = row['县'];
                    const code = row['编码'];
                    if (xian && xian.trim() && !counties.has(xian)) {
                        const xianCode = code ? code.substring(0, 6) : '';
                        counties.set(xian, { name: xian, code: xianCode, province, city });
                    }
                }
            })
            .on('end', () => resolve(Array.from(counties.values())))
            .on('error', (err) => {
                logger.error('读取CSV失败: %s', err.message);
                resolve([]);
            });
    });
}

async function loadTownsFromCSV(year, province, city, county) {
    const csvPath = path.join(CSV_DIR, `2.生成的数据位一到五级(含编码)${year}.csv`);

    if (!fs.existsSync(csvPath)) {
        logger.warn('CSV文件不存在: %s', csvPath);
        return [];
    }

    const towns = new Map();

    return new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(iconv.decodeStream('utf8'))
            .pipe(csv())
            .on('data', (row) => {
                if (row['省'] === province && row['市'] === city && row['县'] === county) {
                    const xiang = row['乡'];
                    const code = row['编码'];
                    if (xiang && xiang.trim() && !towns.has(xiang)) {
                        const xiangCode = code ? code.substring(0, 9) + '000' : '';
                        towns.set(xiang, { name: xiang, code: xiangCode, province, city, county });
                    }
                }
            })
            .on('end', () => resolve(Array.from(towns.values())))
            .on('error', (err) => {
                logger.error('读取CSV失败: %s', err.message);
                resolve([]);
            });
    });
}

async function loadVillagesFromCSV(year, province, city, county, town) {
    const csvPath = path.join(CSV_DIR, `2.生成的数据位一到五级(含编码)${year}.csv`);

    if (!fs.existsSync(csvPath)) {
        logger.warn('CSV文件不存在: %s', csvPath);
        return [];
    }

    const villages = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(iconv.decodeStream('utf8'))
            .pipe(csv())
            .on('data', (row) => {
                if (row['省'] === province && row['市'] === city &&
                    row['县'] === county && row['乡'] === town) {
                    const cun = row['村'];
                    const code = row['编码'];
                    if (cun && cun.trim()) {
                        villages.push({ name: cun, code, province, city, county, town });
                    }
                }
            })
            .on('end', () => resolve(villages))
            .on('error', (err) => {
                logger.error('读取CSV失败: %s', err.message);
                resolve([]);
            });
    });
}

async function loadFullTreeFromCSV(year, province) {
    const csvPath = path.join(CSV_DIR, `2.生成的数据位一到五级(含编码)${year}.csv`);

    if (!fs.existsSync(csvPath)) {
        logger.warn('CSV文件不存在: %s', csvPath);
        return null;
    }

    const tree = new Map();

    return new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(iconv.decodeStream('utf8'))
            .pipe(csv())
            .on('data', (row) => {
                if (row['省'] === province) {
                    const shi = row['市'] || '';
                    const xian = row['县'] || '';
                    const xiang = row['乡'] || '';
                    const cun = row['村'] || '';
                    const code = row['编码'] || '';

                    if (!tree.has(shi)) {
                        tree.set(shi, {
                            name: shi,
                            code: code.substring(0, 4) + '00',
                            counties: new Map()
                        });
                    }

                    if (xian && !tree.get(shi).counties.has(xian)) {
                        tree.get(shi).counties.set(xian, {
                            name: xian,
                            code: code.substring(0, 6),
                            towns: new Map()
                        });
                    }

                    if (xian && xiang && !tree.get(shi).counties.get(xian).towns.has(xiang)) {
                        tree.get(shi).counties.get(xian).towns.set(xiang, {
                            name: xiang,
                            code: code.substring(0, 9) + '000',
                            villages: []
                        });
                    }

                    if (xian && xiang && cun) {
                        tree.get(shi).counties.get(xian).towns.get(xiang).villages.push({
                            name: cun,
                            code: code
                        });
                    }
                }
            })
            .on('end', () => {
                const result = Array.from(tree.values())
                    .filter(shi => shi.name && shi.name.trim() !== '') // 过滤掉空的市级名称（省级数据行）
                    .map(shi => ({
                        name: shi.name,
                        code: shi.code,
                        counties: Array.from(shi.counties.values()).map(xian => ({
                            name: xian.name,
                            code: xian.code,
                            towns: Array.from(xian.towns.values()).map(xiang => ({
                                name: xiang.name,
                                code: xiang.code,
                                villages: xiang.villages
                            }))
                        }))
                    }));
                resolve(result);
            })
            .on('error', (err) => {
                logger.error('读取CSV失败: %s', err.message);
                resolve(null);
            });
    });
}

module.exports = router;