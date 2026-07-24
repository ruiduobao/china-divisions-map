/**
 * 矢量数据查询路由
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { asyncHandler } = require('../middleware/errorHandler');
const ApiResponse = require('../utils/response');
const db = require('../services/database');
const cache = require('../services/cache');
const vectorCache = require('../services/vectorCache');
const preloadedData = require('../utils/preloadedData');
const { config } = require('../config');
const { logger } = require('../utils/logger');

const CACHE_DIR = vectorCache.CACHE_DIR;

/**
 * 获取矢量数据 - 支持年份参数
 * GET /getGsonDB?code={dataCode}&year={year}
 * GET /getCunAddress?code={cunCode} 或 ?address={placeName}
 */
router.get('/', asyncHandler(async (req, res) => {
    const dataCode = req.query.code;
    const address = req.query.address;
    const year = parseInt(req.query.year) || 2023;

    // 如果提供了 address 参数，走村级查询逻辑
    if (address && address.trim() !== '') {
        const results = await queryCunByName(address.trim());

        if (results && results.length > 0) {
            const geojson = buildGeoJSON(results);
            saveGeoJSON(address, geojson);
            return res.json({
                status: 'success',
                message: results[0].hasPolygon ? 'Polygon' : 'Point',
                filepath: `/vectordata/${encodeURIComponent(address)}.gson`
            });
        }

        // 尝试地理编码
        const geocodeResult = await geocode(address);
        if (geocodeResult) {
            return res.json({
                status: 'success',
                message: 'point',
                filepath: `/vectordata/${encodeURIComponent(address)}.gson`
            });
        }

        return ApiResponse.error(res, 'Data not found', 404, 'NOT_FOUND');
    }

    if (!dataCode) {
        return ApiResponse.error(res, 'dataCode is required', 400, 'MISSING_PARAM');
    }

    let results = [];

    // 根据编码格式判断级别
    if (/^\d{2}0000$/.test(dataCode)) {
        // 省级
        results = await queryProvinceData(dataCode, year);
    } else if (/^\d{4}00$/.test(dataCode)) {
        // 地级
        results = await queryCityData(dataCode, year);
    } else if (/^\d{6}$/.test(dataCode) && !/00$/.test(dataCode)) {
        // 县级
        results = await queryCountyData(dataCode, year);
    } else if (/^\d{12}$/.test(dataCode)) {
        if (dataCode.endsWith('000')) {
            // 乡镇级
            results = await queryTownData(dataCode);
        } else {
            // 村级
            results = await queryCunByCode(dataCode, year);
        }
    } else if (/^\d{9}$/.test(dataCode)) {
        // 9位乡镇级编码
        results = await queryTownData(dataCode + '000');
    } else {
        return ApiResponse.error(res, 'Invalid dataCode format', 400, 'INVALID_PARAM');
    }

    if (!results || results.length === 0) {
        return ApiResponse.error(res, 'Data not found', 404, 'NOT_FOUND');
    }

    // 构建GeoJSON
    const geojson = buildGeoJSON(results);
    const filepath = saveGeoJSON(dataCode, geojson);

    res.json({
        status: 'success',
        message: 'Data exported successfully',
        filepath: `/vectordata/${dataCode}.gson`
    });
}));

/**
 * 获取村级数据
 * GET /getCunAddress?code={cunCode} 或 ?address={placeName}
 */
router.get('/cun', asyncHandler(async (req, res) => {
    const cunCode = req.query.code;
    const placeName = req.query.address;
    // 支持 loadMode 参数：point / polygon / auto
    const loadMode = req.query.loadMode || config.village?.loadMode || 'point';

    let results = [];

    if (cunCode && /^\d{12}$/.test(cunCode)) {
        results = await queryCunByCode(cunCode, parseInt(req.query.year) || 2023, loadMode);
    } else if (placeName && placeName.trim() !== '') {
        results = await queryCunByName(placeName.trim(), loadMode);
    } else {
        return ApiResponse.error(res, '需要提供 code 或 address 参数', 400, 'MISSING_PARAM');
    }

    if (results && results.length > 0) {
        const firstResult = results[0];

        if (firstResult.hasPolygon || firstResult.dataType === 'polygon') {
            const geojson = buildGeoJSON(results);
            saveGeoJSON(cunCode || placeName, geojson);
            return res.json({
                status: 'success',
                message: 'Polygon',
                filepath: `/vectordata/${cunCode || placeName}.gson`
            });
        } else {
            const geojson = buildGeoJSON(results);
            saveGeoJSON(cunCode || placeName, geojson);
            return res.json({
                status: 'success',
                message: 'Point',
                filepath: `/vectordata/${cunCode || placeName}.gson`
            });
        }
    }

    // 尝试地理编码
    if (placeName) {
        const geocodeResult = await geocode(placeName);
        if (geocodeResult) {
            return res.json({
                status: 'success',
                message: 'point',
                filepath: `/vectordata/${encodeURIComponent(placeName)}.gson`
            });
        }
    }

    return ApiResponse.error(res, 'Data not found', 404, 'NOT_FOUND');
}));

// ================== 数据库查询函数 ==================

async function queryProvinceData(dataCode, year) {
    const availableYear = await findAvailableYear('SHENG', 'CHN_sheng', year, dataCode, 'first_gid');
    const sql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "SHENG"."CHN_sheng_${availableYear}" WHERE first_gid = $1`;
    return await db.query(sql, [dataCode]);
}

async function queryCityData(dataCode, year) {
    const availableYear = await findAvailableYear('SHI', 'CHN_shi', year, dataCode, 'code');
    const sql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "SHI"."CHN_shi_${availableYear}" WHERE code = $1`;
    return await db.query(sql, [dataCode]);
}

async function queryCountyData(dataCode, year) {
    const availableYear = await findAvailableYear('XIAN', 'CHN_xian', year, dataCode, 'code');
    const sql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIAN"."CHN_xian_${availableYear}" WHERE code = $1`;
    return await db.query(sql, [dataCode]);
}

async function queryTownData(dataCode, placeName = null) {
    if (dataCode && /^\d{12}$/.test(dataCode)) {
        const sql = 'SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIANG"."CHN_xiang_2020" WHERE code = $1';
        return await db.query(sql, [dataCode]);
    }

    if (placeName) {
        const sql = `
            SELECT DISTINCT ON (code) ST_AsGeoJSON(geom, 6) as geojson_geom, *
            FROM "XIANG"."CHN_xiang_2020"
            WHERE name = $1
               OR name = $1 || '街道办事处'
               OR name = $1 || '街道'
               OR name = $1 || '镇'
               OR name = $1 || '乡'
               OR name = $1 || '民族乡'
               OR name = $1 || '苏木'
               OR name = $1 || '民族苏木'
               OR name LIKE '%' || $1 || '%'
            LIMIT 10
        `;
        return await db.query(sql, [placeName]);
    }

    return [];
}

async function queryVillageData(cunCode) {
    const shiCode = cunCode.substring(0, 4) + '00';
    const shengCode = cunCode.substring(0, 2) + '0000';
    const xianCode = cunCode.substring(0, 6);
    const xiangCode = cunCode.substring(0, 9);

    logger.debug('查询村级数据:', cunCode);

    const tableNames = [shiCode, shengCode];

    for (const tableName of tableNames) {
        const exists = await db.tableExists('cunpolygon', tableName);
        if (!exists) continue;

        logger.debug('找到表:', tableName);

        // 精确匹配
        let sql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, name, cun_code, shi_code
                   FROM "cunpolygon"."${tableName}" WHERE cun_code = $1`;
        let results = await db.query(sql, [cunCode]);

        if (results.length > 0) {
            return results.map(r => ({ ...r, hasPolygon: true, matchType: 'exact' }));
        }

        // 乡镇编码匹配
        sql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, name, cun_code, shi_code
               FROM "cunpolygon"."${tableName}"
               WHERE cun_code LIKE $1 AND RIGHT(cun_code, 3) != '999' LIMIT 1`;
        results = await db.query(sql, [xiangCode + '%']);

        if (results.length > 0) {
            return results.map(r => ({ ...r, hasPolygon: true, matchType: 'xiang' }));
        }

        // 街道办整体边界
        sql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, name, cun_code, shi_code
               FROM "cunpolygon"."${tableName}" WHERE cun_code LIKE $1 LIMIT 1`;
        results = await db.query(sql, [xiangCode + '%']);

        if (results.length > 0) {
            return results.map(r => ({ ...r, hasPolygon: true, matchType: 'jiedao' }));
        }
    }

    return [];
}

async function queryCunByCode(cunCode, year = 2023, loadMode = null) {
    loadMode = loadMode || config.village?.loadMode || 'point';

    // 1. 决定是否查面数据
    const wantPolygon = loadMode === 'polygon' || (loadMode === 'auto' && config.village?.enablePolygon === true);
    if (wantPolygon) {
        const results = await queryVillageData(cunCode);
        if (results.length > 0) {
            return results;
        }
    }

    // 2. 从村级索引获取村名信息
    const villageInfo = preloadedData.getVillageByCode(cunCode, year);

    // 3. 查询点数据表
    if (villageInfo && villageInfo.cun) {
        // 用村名和县名精确匹配
        const sql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, fullname as name, cuncode, sheng, shi, xian, xiang, cun
                     FROM "CUN"."chinacunpoint"
                     WHERE cun = $1 AND xian = $2 LIMIT 1`;
        const pointResults = await db.query(sql, [villageInfo.cun, villageInfo.xian]);

        if (pointResults.length > 0) {
            return [{ ...pointResults[0], hasPolygon: false, dataType: 'point', matchedByName: true }];
        }

        // 尝试用村名模糊匹配
        const fuzzySql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, fullname as name, cuncode, sheng, shi, xian, xiang, cun
                          FROM "CUN"."chinacunpoint"
                          WHERE cun LIKE $1 AND xian = $2 LIMIT 1`;
        const fuzzyResults = await db.query(fuzzySql, [`%${villageInfo.cun}%`, villageInfo.xian]);

        if (fuzzyResults.length > 0) {
            return [{ ...fuzzyResults[0], hasPolygon: false, dataType: 'point', matchedByFuzzy: true }];
        }
    }

    // 4. 用县编码查询任意点作为参考
    const xianCode = cunCode.substring(0, 6);
    const fallbackSql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, fullname as name, cuncode, sheng, shi, xian, xiang, cun
                         FROM "CUN"."chinacunpoint"
                         WHERE cuncode LIKE $1 LIMIT 1`;
    const fallbackResults = await db.query(fallbackSql, [xianCode + '%']);

    if (fallbackResults.length > 0) {
        return [{ ...fallbackResults[0], hasPolygon: false, dataType: 'point', matchType: 'county_fallback' }];
    }

    return [];
}

async function queryCunByName(placeName, loadMode = null) {
    loadMode = loadMode || config.village?.loadMode || 'point';
    const wantPolygon = loadMode === 'polygon' || (loadMode === 'auto' && config.village?.enablePolygon === true);

    // 先尝试精确匹配
    let sql = 'SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, fullname, cuncode, sheng, shi, xian, xiang, cun FROM "CUN"."chinacunpoint" WHERE fullname = $1 LIMIT 1';
    let results = await db.query(sql, [placeName]);

    if (results.length > 0) {
        // 想要面数据时，尝试从 cuncode 反查面数据
        if (wantPolygon && results[0].cuncode) {
            const polyResults = await queryVillageData(results[0].cuncode);
            if (polyResults.length > 0) {
                return polyResults;
            }
        }
        return results.map(r => ({ ...r, hasPolygon: false, dataType: 'point' }));
    }

    // 尝试模糊匹配
    sql = 'SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, fullname, cuncode, sheng, shi, xian, xiang, cun FROM "CUN"."chinacunpoint" WHERE fullname LIKE $1 OR cun LIKE $2 LIMIT 5';
    results = await db.query(sql, [`%${placeName}%`, `%${placeName}%`]);

    return results.map(r => ({ ...r, hasPolygon: false, dataType: 'point' }));
}

async function findAvailableYear(schema, baseTableName, preferredYear, dataCode, codeField) {
    for (let y of [preferredYear, ...config.availableYears.filter(y => y !== preferredYear)]) {
        try {
            const checkSql = `SELECT 1 FROM "${schema}"."CHN_${baseTableName.replace('CHN_', '')}_${y}" WHERE ${codeField} = $1 LIMIT 1`;
            const result = await db.queryOne(checkSql, [dataCode]);
            if (result) return y;
        } catch (err) {
            continue;
        }
    }
    return preferredYear;
}

// ================== 辅助函数 ==================

function buildGeoJSON(results) {
    return {
        type: 'FeatureCollection',
        features: results.map(result => {
            const geojsonGeom = JSON.parse(result.geojson_geom);
            delete result.geojson_geom;
            return {
                type: 'Feature',
                geometry: geojsonGeom,
                properties: result
            };
        })
    };
}

function saveGeoJSON(id, geojson) {
    return vectorCache.saveVectorFile(id, geojson);
}

async function geocode(placeName) {
    try {
        const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(placeName)}&key=${config.gaode.apiKey}`;
        const response = await axios.get(url);

        if (response.data?.geocodes?.length > 0) {
            const [lng, lat] = response.data.geocodes[0].location.split(',');
            const geojson = {
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
                    properties: { name: placeName }
                }]
            };
            saveGeoJSON(placeName, geojson);
            return true;
        }
    } catch (err) {
        logger.error('地理编码失败: %s', err.message);
    }
    return false;
}

/**
 * 通过坐标查询县级行政区划
 * GET /api/point-query?lng={经度}&lat={纬度}&year={年份}
 */
router.get('/point-query', asyncHandler(async (req, res) => {
    const lng = parseFloat(req.query.lng);
    const lat = parseFloat(req.query.lat);
    const year = parseInt(req.query.year) || 2023;

    if (isNaN(lng) || isNaN(lat)) {
        return ApiResponse.error(res, '需要提供有效的经纬度参数', 400, 'INVALID_PARAM');
    }

    // 使用PostGIS空间查询找到包含该点的县级边界
    const sql = `
        SELECT 
            ST_AsGeoJSON(geom, 6) as geojson_geom,
            code,
            "地名" as name
        FROM "XIAN"."CHN_xian_${year}"
        WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
        LIMIT 1
    `;

    try {
        const result = await db.queryOne(sql, [lng, lat]);

        if (!result) {
            // 尝试其他年份
            for (const y of [2021, 2018, 2017, 2010]) {
                const fallbackSql = `
                    SELECT 
                        ST_AsGeoJSON(geom, 6) as geojson_geom,
                        code,
                        "地名" as name
                    FROM "XIAN"."CHN_xian_${y}"
                    WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
                    LIMIT 1
                `;
                const fallbackResult = await db.queryOne(fallbackSql, [lng, lat]);
                if (fallbackResult) {
                    // 保存GeoJSON
                    const geojson = {
                        type: 'FeatureCollection',
                        features: [{
                            type: 'Feature',
                            geometry: JSON.parse(fallbackResult.geojson_geom),
                            properties: {
                                code: fallbackResult.code,
                                name: fallbackResult.name,
                                year: y
                            }
                        }]
                    };
                    saveGeoJSON(fallbackResult.code, geojson);

                    // 查询所属省市信息
                    const shengCode = fallbackResult.code.substring(0, 2) + '0000';
                    const shiCode = fallbackResult.code.substring(0, 4) + '00';

                    return res.json({
                        status: 'success',
                        data: {
                            code: fallbackResult.code,
                            name: fallbackResult.name,
                            year: y,
                            shengCode,
                            shiCode,
                            filepath: `/vectordata/${fallbackResult.code}.gson`
                        }
                    });
                }
            }

            return ApiResponse.error(res, '该位置未找到县级数据', 404, 'NOT_FOUND');
        }

        // 保存GeoJSON
        const geojson = {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: JSON.parse(result.geojson_geom),
                properties: {
                    code: result.code,
                    name: result.name,
                    year: year
                }
            }]
        };
        saveGeoJSON(result.code, geojson);

        // 查询所属省市信息
        const shengCode = result.code.substring(0, 2) + '0000';
        const shiCode = result.code.substring(0, 4) + '00';

        res.json({
            status: 'success',
            data: {
                code: result.code,
                name: result.name,
                year: year,
                shengCode,
                shiCode,
                filepath: `/vectordata/${result.code}.gson`
            }
        });
    } catch (err) {
        logger.error('坐标查询失败: %s', err.message);
        return ApiResponse.error(res, '查询失败', 500, 'QUERY_ERROR');
    }
}));

module.exports = router;