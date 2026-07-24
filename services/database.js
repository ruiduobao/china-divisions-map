/**
 * 数据库服务模块
 * 封装数据库操作，提供统一接口
 */

const pgp = require('pg-promise')();
const { config } = require('../config');
const { logger } = require('../utils/logger');
const { DatabaseError } = require('../utils/errors');

// 创建数据库连接
const db = pgp(config.database);

// 连接事件处理
db.connect()
    .then(obj => {
        logger.info('数据库连接成功');
        obj.done(); // 释放测试连接
    })
    .catch(err => {
        logger.error('数据库连接失败: %s', err.message);
    });

/**
 * 执行查询
 */
async function query(sql, params = []) {
    try {
        return await db.any(sql, params);
    } catch (err) {
        logger.error({ sql, params, error: err.message }, '数据库查询错误');
        throw new DatabaseError(`数据库查询失败: ${err.message}`);
    }
}

/**
 * 执行查询单条
 */
async function queryOne(sql, params = []) {
    try {
        return await db.oneOrNone(sql, params);
    } catch (err) {
        logger.error({ sql, params, error: err.message }, '数据库查询错误');
        throw new DatabaseError(`数据库查询失败: ${err.message}`);
    }
}

/**
 * 执行事务
 */
async function transaction(callback) {
    try {
        return await db.tx(callback);
    } catch (err) {
        logger.error({ error: err.message }, '数据库事务错误');
        throw new DatabaseError(`数据库事务失败: ${err.message}`);
    }
}

/**
 * 检查表是否存在
 */
async function tableExists(schema, tableName) {
    const sql = `
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = $2
        )
    `;
    const result = await queryOne(sql, [schema, tableName]);
    return result?.exists || false;
}

/**
 * 查询矢量数据并返回GeoJSON
 */
async function queryGeoJSON(sql, params = []) {
    try {
        const results = await db.any(sql, params);

        if (!results || results.length === 0) {
            return null;
        }

        // 构建GeoJSON FeatureCollection
        const features = results.map(result => {
            const geojsonGeom = JSON.parse(result.geojson_geom);
            delete result.geojson_geom;

            return {
                type: 'Feature',
                geometry: geojsonGeom,
                properties: result
            };
        });

        return {
            type: 'FeatureCollection',
            features
        };
    } catch (err) {
        logger.error({ sql, error: err.message }, 'GeoJSON查询错误');
        throw new DatabaseError(`GeoJSON查询失败: ${err.message}`);
    }
}

module.exports = {
    db,
    query,
    queryOne,
    transaction,
    tableExists,
    queryGeoJSON
};