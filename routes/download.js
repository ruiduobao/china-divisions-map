/**
 * 下载路由
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const archiver = require('archiver');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { GeoJSON2SVG } = require('geojson2svg');
const { asyncHandler } = require('../middleware/errorHandler');
const ApiResponse = require('../utils/response');
const { query, queryOne, tableExists } = require('../services/database');
const { config } = require('../config');
const { logger } = require('../utils/logger');

/**
 * 计算 GeoJSON 的边界框 [minX, minY, maxX, maxY]
 */
function computeBBox(geojson) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    function visit(coords) {
        if (typeof coords[0] === 'number') {
            const [x, y] = coords;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        } else {
            for (const c of coords) visit(c);
        }
    }

    function walk(g) {
        if (!g) return;
        if (g.type === 'FeatureCollection') g.features.forEach(walk);
        else if (g.type === 'Feature') visit(g.geometry?.coordinates || []);
        else if (g.coordinates) visit(g.coordinates);
    }

    walk(geojson);
    if (minX === Infinity) return null;
    return [minX, minY, maxX, maxY];
}

const CACHE_DIR = path.join(__dirname, '../public/vectordata');

/**
 * 村级下载的“模式”决定是否打包哪些内容
 *  - point:  只下载村级点数据（最快）
 *  - polygon: 优先下载村级面数据
 *  - point_plus_xiang: 点数据 + 所属乡镇边界
 *  - point_plus_xian: 点数据 + 所属乡镇 + 所属县级（默认）
 *  - none: 不打包村级
 */
function getVillageBundleOptions(queryMode) {
    const mode = queryMode || config.village?.downloadMode || 'point_plus_xian';
    return {
        includePoint: ['point', 'polygon', 'point_plus_xiang', 'point_plus_xian'].includes(mode),
        includePolygon: mode === 'polygon',
        includeXiang: ['point_plus_xiang', 'point_plus_xian'].includes(mode),
        includeXian: mode === 'point_plus_xian',
        mode
    };
}

// ================== 说明文本模板 ==================

function getReadmeContent(regionName, regionCode, dataTypes = []) {
    let dataTypesStr = dataTypes.length > 0 ? `\n【数据内容】\n${dataTypes.join('\n')}` : '';

    return `数据来源：map.ruiduobao.com
行政区划名称：${regionName}
行政区划编码：${regionCode}
下载时间：${new Date().toLocaleString('zh-CN')}
${dataTypesStr}

【数据时间属性说明】
1. 省级、市级、县级数据有时间属性（来源于CTAMap，网址：www.shengshixian.com（谐音"省市县"））
2. 乡镇、村级数据默认不变（约2020年）

【使用声明】
1. 规范使用：请遵守国家相关法律法规，规范使用本数据
2. 自己负责：使用者对数据的使用行为及其后果自行负责
3. 仅供参考：本数据仅供学术研究、教育学习等参考用途
4. 禁止商用：严禁将本数据用于任何商业用途
5. 下载默认同意：下载数据即表示您已阅读并同意以上条款

【免责声明】
1. 本数据仅供学术研究、教育学习等非商业用途
2. 数据仅供参考，使用者需自行核实

关注微信公众号"锐多宝"获取更多数据`;
}

// ================== 工具函数 ==================

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const ips = forwarded.split(',').map(ip => ip.trim());
        if (ips.length > 0 && ips[0]) return ips[0];
    }
    return req.headers['x-real-ip'] || req.ip || 'unknown';
}

function getRegionName(geojsonData, code) {
    if (geojsonData.features?.length > 0) {
        const props = geojsonData.features[0].properties || {};
        return props.地名 || props.name || props.省 || props.地级 || props.县级 || props.fullname || `行政区划_${code}`;
    }
    return `行政区划_${code}`;
}

async function generateSHP(geojsonData, id) {
    const tmpDir = path.join(CACHE_DIR, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const geojsonPath = path.join(tmpDir, `${id}.geojson`);
    const shpDir = path.join(tmpDir, `shp_${id}`);

    try {
        if (!fs.existsSync(shpDir)) fs.mkdirSync(shpDir, { recursive: true });
        fs.writeFileSync(geojsonPath, JSON.stringify(geojsonData), { encoding: 'utf8' });

        const cmd = `ogr2ogr -f "ESRI Shapefile" "${shpDir}" "${geojsonPath}" -lco ENCODING=GB18030 -lco RESIZE=YES -overwrite`;
        await execAsync(cmd, { timeout: 60000 });

        const files = {};
        const shpFiles = fs.readdirSync(shpDir);
        for (const file of shpFiles) {
            files[path.extname(file).substring(1)] = fs.readFileSync(path.join(shpDir, file));
        }

        // 清理
        fs.unlinkSync(geojsonPath);
        for (const file of shpFiles) fs.unlinkSync(path.join(shpDir, file));
        fs.rmdirSync(shpDir);

        return files;
    } catch (err) {
        logger.error('生成Shapefile失败: %s', err.message);
        // 清理
        try {
            if (fs.existsSync(geojsonPath)) fs.unlinkSync(geojsonPath);
            if (fs.existsSync(shpDir)) {
                const files = fs.readdirSync(shpDir);
                for (const file of files) fs.unlinkSync(path.join(shpDir, file));
                fs.rmdirSync(shpDir);
            }
        } catch (e) {}
        return null;
    }
}

async function generateGPKG(geojsonData, id) {
    const tmpDir = path.join(CACHE_DIR, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const geojsonPath = path.join(tmpDir, `${id}_temp.geojson`);
    const gpkgPath = path.join(tmpDir, `${id}.gpkg`);

    try {
        fs.writeFileSync(geojsonPath, JSON.stringify(geojsonData));
        await execAsync(`ogr2ogr -f GPKG "${gpkgPath}" "${geojsonPath}" -overwrite`, { timeout: 60000 });
        const buffer = fs.readFileSync(gpkgPath);
        fs.unlinkSync(geojsonPath);
        fs.unlinkSync(gpkgPath);
        return buffer;
    } catch (err) {
        logger.error('生成GeoPackage失败: %s', err.message);
        return null;
    }
}

function generateKML(geojsonData, id) {
    let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
    <name>${id}</name>
    <description>Generated by map.ruiduobao.com</description>`;

    if (geojsonData.features) {
        geojsonData.features.forEach((feature, index) => {
            const name = feature.properties?.name || feature.properties?.地名 || `Feature ${index + 1}`;
            if (feature.geometry.type === 'Point') {
                kml += `\n    <Placemark><name>${name}</name><Point><coordinates>${feature.geometry.coordinates[0]},${feature.geometry.coordinates[1]}</coordinates></Point></Placemark>`;
            } else if (feature.geometry.type === 'Polygon') {
                const coords = feature.geometry.coordinates[0].map(c => `${c[0]},${c[1]},0`).join(' ');
                kml += `\n    <Placemark><name>${name}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
            } else if (feature.geometry.type === 'MultiPolygon') {
                feature.geometry.coordinates.forEach((poly, pIdx) => {
                    const coords = poly[0].map(c => `${c[0]},${c[1]},0`).join(' ');
                    kml += `\n    <Placemark><name>${name}_${pIdx + 1}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
                });
            }
        });
    }

    kml += '\n</Document>\n</kml>';
    return kml;
}

/**
 * 生成 SVG 矢量文件
 * @param {object} geojsonData - FeatureCollection
 * @param {string} regionName - 用于 SVG <title> 的名称
 * @param {object} [options]
 * @param {number} [options.width=800]
 * @param {number} [options.height=600]
 * @returns {string} 完整 SVG 文档
 */
function generateSVG(geojsonData, regionName, options = {}) {
    const width = options.width || 800;
    const height = options.height || 600;

    // 把非面/线的 GeometryCollection 等也归一为 FeatureCollection
    let fc = geojsonData;
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
        fc = { type: 'FeatureCollection', features: [] };
    }

    // 计算 bbox
    const bbox = computeBBox(fc);
    if (!bbox) {
        // 空数据时返回最小可用 SVG
        return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${escapeXml(regionName || 'empty')}</title><text x="50%" y="50%" text-anchor="middle" fill="#999" font-size="20">无矢量数据</text></svg>`;
    }

    const [minX, minY, maxX, maxY] = bbox;
    // 加 5% 边距，避免图形贴边
    const dx = (maxX - minX) || 1e-6;
    const dy = (maxY - minY) || 1e-6;
    const padX = dx * 0.05;
    const padY = dy * 0.05;
    const extent = {
        left: minX - padX,
        bottom: minY - padY,
        right: maxX + padX,
        top: maxY + padY
    };

    const converter = new GeoJSON2SVG({
        viewportSize: { width, height },
        mapExtent: extent
    });

    // 分类型渲染，给点和线一点样式
    const polyD = [];
    const lineD = [];
    const pointD = [];

    function colorize(i, total) {
        // 简单稳定的色相分布
        const hue = total > 0 ? Math.round((i / total) * 360) : 200;
        return `hsl(${hue}, 70%, 50%)`;
    }

    // geojson2svg 返回的是字符串数组，元素形如：<path d="..."/>
    // 我们需要从字符串中提取 d= 后的值，或者用 text-only 模式直接得到路径数据
    function extractD(svgStr) {
        // 匹配 d="..." 的内容
        const m = svgStr && svgStr.match(/\sd="([^"]*)"/);
        return m ? m[1] : '';
    }

    if (fc.features && fc.features.length > 0) {
        fc.features.forEach((feature, idx) => {
            if (!feature || !feature.geometry) return;
            const single = { type: 'FeatureCollection', features: [feature] };
            const t = feature.geometry.type;
            let arr;
            try {
                arr = converter.convert(single);
            } catch (e) {
                logger.warn('SVG 转换失败,跳过 feature: %s', e.message);
                return;
            }
            const dList = arr.map(extractD).filter(s => s);
            if (t === 'Polygon' || t === 'MultiPolygon') {
                polyD.push(...dList);
            } else if (t === 'LineString' || t === 'MultiLineString') {
                lineD.push(...dList);
            } else if (t === 'Point' || t === 'MultiPoint') {
                pointD.push(...dList);
            } else {
                polyD.push(...dList);
            }
        });
    }

    const total = fc.features.length || 1;
    const polySvg = polyD.map((d, i) => {
        const fill = colorize(i, total);
        return `<path d="${escapeXml(d)}" fill="${fill}" fill-opacity="0.35" stroke="${fill}" stroke-width="1"/>`;
    }).join('\n  ');
    const lineSvg = lineD.map((d) =>
        `<path d="${escapeXml(d)}" fill="none" stroke="#e74c3c" stroke-width="1.5"/>`).join('\n  ');
    const pointSvg = pointD.map((d) => {
        // 点的 path d 形如 "M x,y m-1,0 a..."，需要从中提取中心点
        // 取第一个坐标对 "M x,y"
        const m = d.match(/^M\s*([-\d.]+)[,\s]+([-\d.]+)/);
        if (m) {
            return `<circle cx="${m[1]}" cy="${m[2]}" r="2.5" fill="#2c3e50" stroke="#fff" stroke-width="0.5"/>`;
        }
        return `<path d="${escapeXml(d)}" fill="#2c3e50"/>`;
    }).join('\n  ');

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>${escapeXml(regionName || 'region')}</title>
  <desc>Generated by map.ruiduobao.com · bbox=[${minX.toFixed(6)},${minY.toFixed(6)},${maxX.toFixed(6)},${maxY.toFixed(6)}]</desc>
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
  <g id="polygons">
  ${polySvg}
  </g>
  <g id="lines">
  ${lineSvg}
  </g>
  <g id="points">
  ${pointSvg}
  </g>
</svg>`;
}

function escapeXml(s) {
    if (s === undefined || s === null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ================== 村级数据查询函数 ==================

/**
 * 查询村级面数据
 * @param {string} codePrefix - 区划码前缀（县级6位或市级4位）
 */
async function queryVillagePolygonData(codePrefix) {
    const features = [];

    // 获取可能的表名
    const possibleTables = [];

    // 尝试市级编码表
    if (codePrefix.length >= 4) {
        const shiCode = codePrefix.substring(0, 4) + '00';
        possibleTables.push(shiCode);
    }

    // 尝试省级编码表
    if (codePrefix.length >= 2) {
        const shengCode = codePrefix.substring(0, 2) + '0000';
        possibleTables.push(shengCode);
    }

    for (const tableName of possibleTables) {
        const exists = await tableExists('cunpolygon', tableName);
        if (!exists) continue;

        try {
            // 查询匹配的村级面数据
            const sql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, name, cun_code, shi_code
                         FROM "cunpolygon"."${tableName}"
                         WHERE cun_code LIKE $1
                         LIMIT 5000`;

            const results = await query(sql, [codePrefix + '%']);

            for (const r of results) {
                if (r.geojson_geom) {
                    features.push({
                        type: 'Feature',
                        geometry: JSON.parse(r.geojson_geom),
                        properties: {
                            name: r.name,
                            cun_code: r.cun_code,
                            shi_code: r.shi_code
                        }
                    });
                }
            }

            if (features.length > 0) {
                logger.info(`从表 ${tableName} 查询到 ${features.length} 条村级面数据`);
                break; // 找到数据就退出
            }
        } catch (err) {
            logger.error('查询村级面数据失败: %s', err.message);
        }
    }

    return {
        type: 'FeatureCollection',
        features: features
    };
}

/**
 * 查询村级点数据
 * @param {string} codePrefix - 区划码前缀（县级6位或市级4位）
 */
async function queryVillagePointData(codePrefix) {
    try {
        // 根据前缀长度决定匹配方式
        let sql, params;

        if (codePrefix.length === 6) {
            // 县级：匹配前6位
            sql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, fullname, cuncode, sheng, shi, xian, xiang, cun
                   FROM "CUN"."chinacunpoint"
                   WHERE cuncode LIKE $1
                   LIMIT 5000`;
            params = [codePrefix + '%'];
        } else if (codePrefix.length === 4) {
            // 市级：匹配前4位
            sql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, fullname, cuncode, sheng, shi, xian, xiang, cun
                   FROM "CUN"."chinacunpoint"
                   WHERE cuncode LIKE $1
                   LIMIT 10000`;
            params = [codePrefix + '%'];
        } else {
            return { type: 'FeatureCollection', features: [] };
        }

        const results = await query(sql, params);
        const features = [];

        for (const r of results) {
            if (r.geojson_geom) {
                features.push({
                    type: 'Feature',
                    geometry: JSON.parse(r.geojson_geom),
                    properties: {
                        fullname: r.fullname,
                        cuncode: r.cuncode,
                        sheng: r.sheng,
                        shi: r.shi,
                        xian: r.xian,
                        xiang: r.xiang,
                        cun: r.cun
                    }
                });
            }
        }

        logger.info(`查询到 ${features.length} 条村级点数据`);
        return {
            type: 'FeatureCollection',
            features: features
        };
    } catch (err) {
        logger.error('查询村级点数据失败: %s', err.message);
        return { type: 'FeatureCollection', features: [] };
    }
}

// ================== 批量下载路由 ==================

/**
 * 批量下载县级数据
 * GET /downloadCountyBatch/county/:code?format={format}&year={year}
 */
router.get('/county/:code', asyncHandler(async (req, res) => {
    const code = req.params.code;
    const format = req.query.format || 'shp';
    const year = parseInt(req.query.year) || 2023;

    if (!/^\d{6}$/.test(code) || code.endsWith('00')) {
        return ApiResponse.error(res, '无效的县级编码', 400, 'INVALID_PARAM');
    }

    logger.info('批量下载县级数据:', code, '格式:', format, '年份:', year);

    const qrcodePath = path.join(__dirname, '../public/pics/gongzhonghao.jpg');
    const wechatPath = path.join(__dirname, '../public/pics/站长微信.png');
    const xianCode = code;

    // 获取县级名称
    const xianData = await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIAN"."CHN_xian_${year}" WHERE code = $1`, [xianCode]);
    const xianName = xianData?.[0]?.地名 || xianData?.[0]?.name || xianCode;

    // 获取乡镇数据（合并）
    const xiangResults = await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIANG"."CHN_xiang_2020" WHERE code LIKE $1`, [xianCode + '%']);

    // 获取村级数据（按下载模式决定）
    const bundleOpts = getVillageBundleOptions(req.query.village);
    let villagePolygonData = { type: 'FeatureCollection', features: [] };
    let villagePointData = { type: 'FeatureCollection', features: [] };

    if (bundleOpts.includePoint) {
        villagePointData = await queryVillagePointData(xianCode);
    }
    // 面数据仅在 polygon 模式且全局启用时查询
    if (bundleOpts.includePolygon && config.village?.enablePolygon === true) {
        villagePolygonData = await queryVillagePolygonData(xianCode);
    }

    const zipPath = path.join(CACHE_DIR, `batch_xian_${xianCode}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    const dataTypes = [];

    archive.on('error', (err) => {
        logger.error('压缩错误: %s', err.message);
        try { fs.unlinkSync(zipPath); } catch (e) {}
    });

    archive.pipe(output);

    try {
        // 1. 添加县级数据
        if (xianData?.length > 0) {
            const xianGeojson = {
                type: 'FeatureCollection',
                features: xianData.map(r => {
                    const geojsonGeom = JSON.parse(r.geojson_geom);
                    delete r.geojson_geom;
                    return { type: 'Feature', geometry: geojsonGeom, properties: r };
                })
            };
            archive.append(JSON.stringify(xianGeojson, null, 2), { name: `县级/${xianName}_${xianCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(xianGeojson, `xian_${xianCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `县级/${xianName}_${xianCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(xianGeojson, `${xianName}_${xianCode}`), { name: `县级/${xianName}_${xianCode}.svg` });
            }
            dataTypes.push('- 县级边界数据');
        }

        // 2. 添加乡镇数据（合并为一个文件）
        if (xiangResults?.length > 0) {
            const xiangGeojson = {
                type: 'FeatureCollection',
                features: xiangResults.map(r => {
                    const geojsonGeom = JSON.parse(r.geojson_geom);
                    delete r.geojson_geom;
                    return { type: 'Feature', geometry: geojsonGeom, properties: r };
                })
            };
            archive.append(JSON.stringify(xiangGeojson, null, 2), { name: `乡镇/乡镇边界_${xianCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(xiangGeojson, `xiang_${xianCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `乡镇/乡镇边界_${xianCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(xiangGeojson, `乡镇边界_${xianCode}`), { name: `乡镇/乡镇边界_${xianCode}.svg` });
            }
            dataTypes.push(`- 乡镇边界数据（${xiangResults.length}个乡镇）`);
        }

        // 3. 添加村级面数据
        if (villagePolygonData.features.length > 0) {
            archive.append(JSON.stringify(villagePolygonData, null, 2), { name: `村级/村边界_面数据_${xianCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(villagePolygonData, `cun_polygon_${xianCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `村级/村边界_面数据_${xianCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(villagePolygonData, `村边界_面数据_${xianCode}`), { name: `村级/村边界_面数据_${xianCode}.svg` });
            }
            dataTypes.push(`- 村级面数据（${villagePolygonData.features.length}个村）`);
        }

        // 4. 添加村级点数据
        if (villagePointData.features.length > 0) {
            archive.append(JSON.stringify(villagePointData, null, 2), { name: `村级/村位置_点数据_${xianCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(villagePointData, `cun_point_${xianCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `村级/村位置_点数据_${xianCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(villagePointData, `村位置_点数据_${xianCode}`), { name: `村级/村位置_点数据_${xianCode}.svg` });
            }
            dataTypes.push(`- 村级点数据（${villagePointData.features.length}个村）`);
        }
        // 补一个声明：村级没有加时
        if (!bundleOpts.includePoint && !bundleOpts.includePolygon) {
            dataTypes.push('- 未包含村级数据（未选择包含村级）');
        }

        // 5. 添加二维码和说明文件
        if (fs.existsSync(qrcodePath)) archive.file(qrcodePath, { name: '关注公众号_锐多宝.jpg' });
        if (fs.existsSync(wechatPath)) archive.file(wechatPath, { name: '站长微信.png' });

        archive.append(getReadmeContent(xianName, xianCode, dataTypes), { name: '说明.txt' });

        await archive.finalize();

        // 等待文件写入完成
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
        });

        res.download(zipPath, `${xianName}_${xianCode}_批量下载.zip`, (err) => {
            if (err) logger.error('下载错误: %s', err.message);
            try { fs.unlinkSync(zipPath); } catch (e) {}
        });
    } catch (err) {
        logger.error('批量下载县级失败: %s', err.message);
        try { fs.unlinkSync(zipPath); } catch (e) {}
        return ApiResponse.error(res, '批量下载失败: ' + err.message, 500, 'SERVER_ERROR');
    }
}));

/**
 * 批量下载地级市数据
 * GET /downloadCityBatch/city/:code?format={format}&year={year}
 */
router.get('/city/:code', asyncHandler(async (req, res) => {
    const code = req.params.code;
    const format = req.query.format || 'shp';
    const year = parseInt(req.query.year) || 2023;

    // 支持4位或6位编码
    const cityCode = code.length === 4 ? code + '00' : code;

    if (!/^\d{4}00$/.test(cityCode)) {
        return ApiResponse.error(res, '无效的地级市编码', 400, 'INVALID_PARAM');
    }

    logger.info('批量下载地级市数据:', cityCode, '格式:', format, '年份:', year);

    const qrcodePath = path.join(__dirname, '../public/pics/gongzhonghao.jpg');
    const wechatPath = path.join(__dirname, '../public/pics/站长微信.png');
    const cityPrefix = cityCode.substring(0, 4);

    // 获取市级名称
    const shiData = await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "SHI"."CHN_shi_${year}" WHERE code = $1`, [cityCode]);
    const shiName = shiData?.[0]?.地名 || shiData?.[0]?.name || cityCode;

    // 获取县级数据（合并）
    const xianResults = await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIAN"."CHN_xian_${year}" WHERE code LIKE $1`, [cityPrefix + '%']);

    // 获取乡镇数据（合并）
    const xiangResults = await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIANG"."CHN_xiang_2020" WHERE code LIKE $1`, [cityPrefix + '%']);

    // 获取村级数据（按下载模式决定）
    const bundleOpts = getVillageBundleOptions(req.query.village);
    let villagePolygonData = { type: 'FeatureCollection', features: [] };
    let villagePointData = { type: 'FeatureCollection', features: [] };

    if (bundleOpts.includePoint) {
        villagePointData = await queryVillagePointData(cityPrefix);
    }
    if (bundleOpts.includePolygon && config.village?.enablePolygon === true) {
        villagePolygonData = await queryVillagePolygonData(cityPrefix);
    }

    const zipPath = path.join(CACHE_DIR, `batch_city_${cityCode}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    const dataTypes = [];

    archive.on('error', (err) => {
        logger.error('压缩错误: %s', err.message);
        try { fs.unlinkSync(zipPath); } catch (e) {}
    });

    archive.pipe(output);

    try {
        // 1. 添加市级数据
        if (shiData?.length > 0) {
            const shiGeojson = {
                type: 'FeatureCollection',
                features: shiData.map(r => {
                    const geojsonGeom = JSON.parse(r.geojson_geom);
                    delete r.geojson_geom;
                    return { type: 'Feature', geometry: geojsonGeom, properties: r };
                })
            };
            archive.append(JSON.stringify(shiGeojson, null, 2), { name: `市级/${shiName}_${cityCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(shiGeojson, `shi_${cityCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `市级/${shiName}_${cityCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(shiGeojson, `${shiName}_${cityCode}`), { name: `市级/${shiName}_${cityCode}.svg` });
            }
            dataTypes.push('- 市级边界数据');
        }

        // 2. 添加县级数据（合并为一个文件）
        if (xianResults?.length > 0) {
            const xianGeojson = {
                type: 'FeatureCollection',
                features: xianResults.map(r => {
                    const geojsonGeom = JSON.parse(r.geojson_geom);
                    delete r.geojson_geom;
                    return { type: 'Feature', geometry: geojsonGeom, properties: r };
                })
            };
            archive.append(JSON.stringify(xianGeojson, null, 2), { name: `县级/县级边界_${cityCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(xianGeojson, `xian_${cityCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `县级/县级边界_${cityCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(xianGeojson, `县级边界_${cityCode}`), { name: `县级/县级边界_${cityCode}.svg` });
            }
            dataTypes.push(`- 县级边界数据（${xianResults.length}个县/区）`);
        }

        // 3. 添加乡镇数据（合并为一个文件）
        if (xiangResults?.length > 0) {
            const xiangGeojson = {
                type: 'FeatureCollection',
                features: xiangResults.map(r => {
                    const geojsonGeom = JSON.parse(r.geojson_geom);
                    delete r.geojson_geom;
                    return { type: 'Feature', geometry: geojsonGeom, properties: r };
                })
            };
            archive.append(JSON.stringify(xiangGeojson, null, 2), { name: `乡镇/乡镇边界_${cityCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(xiangGeojson, `xiang_${cityCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `乡镇/乡镇边界_${cityCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(xiangGeojson, `乡镇边界_${cityCode}`), { name: `乡镇/乡镇边界_${cityCode}.svg` });
            }
            dataTypes.push(`- 乡镇边界数据（${xiangResults.length}个乡镇）`);
        }

        // 4. 添加村级面数据
        if (villagePolygonData.features.length > 0) {
            archive.append(JSON.stringify(villagePolygonData, null, 2), { name: `村级/村边界_面数据_${cityCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(villagePolygonData, `cun_polygon_${cityCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `村级/村边界_面数据_${cityCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(villagePolygonData, `村边界_面数据_${cityCode}`), { name: `村级/村边界_面数据_${cityCode}.svg` });
            }
            dataTypes.push(`- 村级面数据（${villagePolygonData.features.length}个村）`);
        }

        // 5. 添加村级点数据
        if (villagePointData.features.length > 0) {
            archive.append(JSON.stringify(villagePointData, null, 2), { name: `村级/村位置_点数据_${cityCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(villagePointData, `cun_point_${cityCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `村级/村位置_点数据_${cityCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(villagePointData, `村位置_点数据_${cityCode}`), { name: `村级/村位置_点数据_${cityCode}.svg` });
            }
            dataTypes.push(`- 村级点数据（${villagePointData.features.length}个村）`);
        }

        // 6. 添加二维码和说明文件
        if (fs.existsSync(qrcodePath)) archive.file(qrcodePath, { name: '关注公众号_锐多宝.jpg' });
        if (fs.existsSync(wechatPath)) archive.file(wechatPath, { name: '站长微信.png' });

        archive.append(getReadmeContent(shiName, cityCode, dataTypes), { name: '说明.txt' });

        await archive.finalize();

        // 等待文件写入完成
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
        });

        res.download(zipPath, `${shiName}_${cityCode}_批量下载.zip`, (err) => {
            if (err) logger.error('下载错误: %s', err.message);
            try { fs.unlinkSync(zipPath); } catch (e) {}
        });
    } catch (err) {
        logger.error('批量下载地级市失败: %s', err.message);
        try { fs.unlinkSync(zipPath); } catch (e) {}
        return ApiResponse.error(res, '批量下载失败: ' + err.message, 500, 'SERVER_ERROR');
    }
}));

/**
 * 批量下载乡镇数据
 * GET /downloadTownBatch/town/:code?format={format}&year={year}
 */
router.get('/town/:code', asyncHandler(async (req, res) => {
    const code = req.params.code;
    const format = req.query.format || 'shp';
    const year = parseInt(req.query.year) || 2023;

    if (!/^\d{12}$/.test(code) || !code.endsWith('000')) {
        return ApiResponse.error(res, '无效的乡镇编码', 400, 'INVALID_PARAM');
    }

    logger.info('批量下载乡镇数据:', code, '格式:', format, '年份:', year);

    const qrcodePath = path.join(__dirname, '../public/pics/gongzhonghao.jpg');
    const wechatPath = path.join(__dirname, '../public/pics/站长微信.png');
    const xiangCode = code;

    // 获取乡镇名称
    const xiangData = await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIANG"."CHN_xiang_2020" WHERE code = $1`, [xiangCode]);
    const xiangName = xiangData?.[0]?.地名 || xiangData?.[0]?.name || xiangCode;

    // 获取该乡镇下的村级数据（按下载模式决定）
    const bundleOpts = getVillageBundleOptions(req.query.village);
    let villagePolygonData = { type: 'FeatureCollection', features: [] };
    let villagePointData = { type: 'FeatureCollection', features: [] };
    const cunPrefix = xiangCode.substring(0, 9);

    if (bundleOpts.includePoint) {
        villagePointData = await queryVillagePointData(cunPrefix);
    }
    if (bundleOpts.includePolygon && config.village?.enablePolygon === true) {
        villagePolygonData = await queryVillagePolygonData(cunPrefix);
    }

    const zipPath = path.join(CACHE_DIR, `batch_xiang_${xiangCode}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    const dataTypes = [];

    archive.on('error', (err) => {
        logger.error('压缩错误: %s', err.message);
        try { fs.unlinkSync(zipPath); } catch (e) {}
    });

    archive.pipe(output);

    try {
        // 1. 添加乡镇数据
        if (xiangData?.length > 0) {
            const xiangGeojson = {
                type: 'FeatureCollection',
                features: xiangData.map(r => {
                    const geojsonGeom = JSON.parse(r.geojson_geom);
                    delete r.geojson_geom;
                    return { type: 'Feature', geometry: geojsonGeom, properties: r };
                })
            };
            archive.append(JSON.stringify(xiangGeojson, null, 2), { name: `乡镇/${xiangName}_${xiangCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(xiangGeojson, `xiang_${xiangCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `乡镇/${xiangName}_${xiangCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(xiangGeojson, `${xiangName}_${xiangCode}`), { name: `乡镇/${xiangName}_${xiangCode}.svg` });
            }
            dataTypes.push('- 乡镇边界数据');
        }

        // 2. 添加村级面数据
        if (villagePolygonData.features.length > 0) {
            archive.append(JSON.stringify(villagePolygonData, null, 2), { name: `村级/村边界_面数据_${xiangCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(villagePolygonData, `cun_polygon_${xiangCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `村级/村边界_面数据_${xiangCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(villagePolygonData, `村边界_面数据_${xiangCode}`), { name: `村级/村边界_面数据_${xiangCode}.svg` });
            }
            dataTypes.push(`- 村级面数据（${villagePolygonData.features.length}个村）`);
        }

        // 3. 添加村级点数据
        if (villagePointData.features.length > 0) {
            archive.append(JSON.stringify(villagePointData, null, 2), { name: `村级/村位置_点数据_${xiangCode}.geojson` });

            if (format === 'shp') {
                const shpFiles = await generateSHP(villagePointData, `cun_point_${xiangCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `村级/村位置_点数据_${xiangCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(villagePointData, `村位置_点数据_${xiangCode}`), { name: `村级/村位置_点数据_${xiangCode}.svg` });
            }
            dataTypes.push(`- 村级点数据（${villagePointData.features.length}个村）`);
        }

        // 4. 添加二维码和说明文件
        if (fs.existsSync(qrcodePath)) archive.file(qrcodePath, { name: '关注公众号_锐多宝.jpg' });
        if (fs.existsSync(wechatPath)) archive.file(wechatPath, { name: '站长微信.png' });

        archive.append(getReadmeContent(xiangName, xiangCode, dataTypes), { name: '说明.txt' });

        await archive.finalize();

        // 等待文件写入完成
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
        });

        res.download(zipPath, `${xiangName}_${xiangCode}_批量下载.zip`, (err) => {
            if (err) logger.error('下载错误: %s', err.message);
            try { fs.unlinkSync(zipPath); } catch (e) {}
        });
    } catch (err) {
        logger.error('批量下载乡镇失败: %s', err.message);
        try { fs.unlinkSync(zipPath); } catch (e) {}
        return ApiResponse.error(res, '批量下载失败: ' + err.message, 500, 'SERVER_ERROR');
    }
}));

// ================== 村级批量下载（点 + 所在乡镇 + 所在县） ==================

/**
 * 批量下载村级数据（按 loadMode / downloadMode 决定内容）
 * GET /downloadVillageBatch/village/:code?format=shp&year=2023&village=point_plus_xian
 *
 * :code 为 12 位村级编码。
 * 下载包内容（默认 point_plus_xian 模式）：
 *   - 村级/<村名>_xxx.geojson/shp  （点或面）
 *   - 乡镇/<乡镇名>_xxx.geojson/shp
 *   - 县级/<县名>_xxx.geojson/shp
 */
router.get('/village/:code', asyncHandler(async (req, res) => {
    const code = req.params.code;
    const format = req.query.format || 'shp';
    const year = parseInt(req.query.year) || 2023;

    if (!/^\d{12}$/.test(code) || code.endsWith('000')) {
        return ApiResponse.error(res, '无效的村级编码', 400, 'INVALID_PARAM');
    }

    logger.info('批量下载村级数据:', code, '格式:', format, '年份:', year);

    const qrcodePath = path.join(__dirname, '../public/pics/gongzhonghao.jpg');
    const wechatPath = path.join(__dirname, '../public/pics/站长微信.png');

    const xianCode = code.substring(0, 6);
    const xiangCode = code.substring(0, 9) + '000';
    const shiCode = code.substring(0, 4) + '00';
    const shengCode = code.substring(0, 2) + '0000';

    // 1. 村级点 / 面数据
    const bundleOpts = getVillageBundleOptions(req.query.village);
    const loadMode = req.query.loadMode || config.village?.loadMode || 'point';

    let cunFeatures = [];
    let cunName = `村_${code}`;
    let cunDataType = 'point';

    if (loadMode === 'polygon' || (loadMode === 'auto' && config.village?.enablePolygon === true)) {
        const poly = await queryVillageData(code);
        if (poly.length > 0) {
            cunFeatures = poly.map(r => {
                const geom = JSON.parse(r.geojson_geom);
                const props = { ...r };
                delete props.geojson_geom;
                return { type: 'Feature', geometry: geom, properties: { ...props, name: r.name || cunName } };
            });
            cunName = poly[0].name || cunName;
            cunDataType = 'polygon';
        }
    }

    if (cunFeatures.length === 0) {
        // 回退到点数据
        const pointSql = `SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, fullname, cuncode, sheng, shi, xian, xiang, cun
                          FROM "CUN"."chinacunpoint"
                          WHERE cuncode = $1 OR cuncode LIKE $2
                          LIMIT 1`;
        const pointResult = await queryOne(pointSql, [code, xianCode + '%']);
        if (pointResult) {
            const geom = JSON.parse(pointResult.geojson_geom);
            cunFeatures = [{
                type: 'Feature',
                geometry: geom,
                properties: { ...pointResult, name: pointResult.fullname || pointResult.cun }
            }];
            cunName = pointResult.fullname || pointResult.cun || cunName;
            cunDataType = 'point';
        } else {
            return ApiResponse.error(res, '该村级编码未找到数据: ' + code, 404, 'NOT_FOUND');
        }
    }

    const cunGeojson = { type: 'FeatureCollection', features: cunFeatures };

    // 2. 所属乡镇边界
    let xiangGeojson = null;
    let xiangName = `乡镇_${xiangCode}`;
    if (bundleOpts.includeXiang || bundleOpts.includeXian) {
        const xiangRows = await query('SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIANG"."CHN_xiang_2020" WHERE code = $1', [xiangCode]);
        if (xiangRows.length > 0) {
            xiangName = xiangRows[0].name || xiangName;
            xiangGeojson = {
                type: 'FeatureCollection',
                features: xiangRows.map(r => {
                    const geom = JSON.parse(r.geojson_geom);
                    const props = { ...r };
                    delete props.geojson_geom;
                    return { type: 'Feature', geometry: geom, properties: props };
                })
            };
        }
    }

    // 3. 所属县级边界
    let xianGeojson = null;
    let xianName = `县_${xianCode}`;
    if (bundleOpts.includeXian) {
        const xianRows = await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIAN"."CHN_xian_${year}" WHERE code = $1`, [xianCode]);
        if (xianRows.length > 0) {
            xianName = xianRows[0].地名 || xianRows[0].name || xianName;
            xianGeojson = {
                type: 'FeatureCollection',
                features: xianRows.map(r => {
                    const geom = JSON.parse(r.geojson_geom);
                    const props = { ...r };
                    delete props.geojson_geom;
                    return { type: 'Feature', geometry: geom, properties: props };
                })
            };
        }
    }

    // 4. 打 ZIP
    const zipPath = path.join(CACHE_DIR, `batch_cun_${code}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const dataTypes = [];

    archive.on('error', (err) => {
        logger.error('压缩错误: %s', err.message);
        try { fs.unlinkSync(zipPath); } catch (e) {}
    });

    archive.pipe(output);

    try {
        // 村级
        archive.append(JSON.stringify(cunGeojson, null, 2), { name: `村级/${cunName}_${code}.geojson` });
        if (format === 'shp') {
            const shpFiles = await generateSHP(cunGeojson, `cun_${code}`);
            if (shpFiles) {
                for (const [ext, buffer] of Object.entries(shpFiles)) {
                    archive.append(buffer, { name: `村级/${cunName}_${code}.${ext}` });
                }
            }
        } else if (format === 'svg') {
            archive.append(generateSVG(cunGeojson, `${cunName}_${code}`), { name: `村级/${cunName}_${code}.svg` });
        }
        dataTypes.push(`- 村级${cunDataType === 'polygon' ? '面' : '点'}数据（${cunFeatures.length}个）`);

        // 乡镇
        if (xiangGeojson) {
            archive.append(JSON.stringify(xiangGeojson, null, 2), { name: `乡镇/${xiangName}_${xiangCode}.geojson` });
            if (format === 'shp') {
                const shpFiles = await generateSHP(xiangGeojson, `xiang_${xiangCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `乡镇/${xiangName}_${xiangCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(xiangGeojson, `${xiangName}_${xiangCode}`), { name: `乡镇/${xiangName}_${xiangCode}.svg` });
            }
            dataTypes.push(`- 所属乡镇边界（${xiangName}）`);
        }

        // 县级
        if (xianGeojson) {
            archive.append(JSON.stringify(xianGeojson, null, 2), { name: `县级/${xianName}_${xianCode}.geojson` });
            if (format === 'shp') {
                const shpFiles = await generateSHP(xianGeojson, `xian_${xianCode}`);
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `县级/${xianName}_${xianCode}.${ext}` });
                    }
                }
            } else if (format === 'svg') {
                archive.append(generateSVG(xianGeojson, `${xianName}_${xianCode}`), { name: `县级/${xianName}_${xianCode}.svg` });
            }
            dataTypes.push(`- 所属县级边界（${xianName}）`);
        }

        // 二维码 + 说明
        if (fs.existsSync(qrcodePath)) archive.file(qrcodePath, { name: '关注公众号_锐多宝.jpg' });
        if (fs.existsSync(wechatPath)) archive.file(wechatPath, { name: '站长微信.png' });
        archive.append(getReadmeContent(cunName, code, dataTypes), { name: '说明.txt' });

        await archive.finalize();
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
        });

        const fname = `${cunName}_${code}_村级批量下载.zip`;
        res.download(zipPath, fname, (err) => {
            if (err) logger.error('下载错误: %s', err.message);
            try { fs.unlinkSync(zipPath); } catch (e) {}
        });
    } catch (err) {
        logger.error('村级批量下载失败: %s', err.message);
        try { fs.unlinkSync(zipPath); } catch (e) {}
        return ApiResponse.error(res, '村级批量下载失败: ' + err.message, 500, 'SERVER_ERROR');
    }
}));

// ================== 单个下载路由 (必须在批量路由之后) ==================

/**
 * 下载矢量数据
 * GET /downloadVector/:id?format={format}&year={year}
 */
router.get('/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const format = req.query.format || 'geojson';
    const year = parseInt(req.query.year) || 2023;

    const qrcodePath = path.join(__dirname, '../public/pics/gongzhonghao.jpg');
    const wechatPath = path.join(__dirname, '../public/pics/站长微信.png');
    const vectorFilePath = path.join(CACHE_DIR, `${id}.gson`);

    // 如果文件不存在，从数据库生成
    if (!fs.existsSync(vectorFilePath)) {
        logger.info('文件不存在，尝试生成:', id, '年份:', year);

        if (/^\d+$/.test(id)) {
            const results = await getGsonDataByCode(id, year);
            if (results?.length > 0) {
                const geojson = {
                    type: 'FeatureCollection',
                    features: results.map(r => {
                        const geojsonGeom = JSON.parse(r.geojson_geom);
                        delete r.geojson_geom;
                        return { type: 'Feature', geometry: geojsonGeom, properties: r };
                    })
                };
                fs.writeFileSync(vectorFilePath, JSON.stringify(geojson));
            } else {
                return ApiResponse.error(res, '数据不存在: ' + id, 404, 'NOT_FOUND');
            }
        } else {
            // 地名查询
            const decodedId = decodeURIComponent(id);
            const results = await queryTownData(null, decodedId);

            if (results?.length > 0) {
                const geojson = {
                    type: 'FeatureCollection',
                    features: results.map(r => {
                        const geojsonGeom = JSON.parse(r.geojson_geom);
                        delete r.geojson_geom;
                        return { type: 'Feature', geometry: geojsonGeom, properties: r };
                    })
                };
                fs.writeFileSync(vectorFilePath, JSON.stringify(geojson));
            } else {
                // 地理编码
                const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(decodedId)}&key=${config.gaode.apiKey}`;
                const response = await axios.get(url);

                if (response.data?.geocodes?.length > 0) {
                    const [lng, lat] = response.data.geocodes[0].location.split(',');
                    const geojson = {
                        type: 'FeatureCollection',
                        features: [{
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
                            properties: { name: decodedId }
                        }]
                    };
                    fs.writeFileSync(vectorFilePath, JSON.stringify(geojson));
                } else {
                    return ApiResponse.error(res, '未找到该地名: ' + decodedId, 404, 'NOT_FOUND');
                }
            }
        }
    }

    // 创建下载ZIP
    const geojsonData = JSON.parse(fs.readFileSync(vectorFilePath, 'utf8'));
    const regionName = getRegionName(geojsonData, id);
    const friendlyFilename = `${regionName}_${id}_关注锐多宝获取更多资讯`;
    const internalName = `${regionName}_${id}`;

    let shpFiles = null, gpkgBuffer = null, kmlContent = null, svgContent = null;
    if (format === 'shp') shpFiles = await generateSHP(geojsonData, id);
    else if (format === 'gpkg') gpkgBuffer = await generateGPKG(geojsonData, id);
    else if (format === 'kml') kmlContent = generateKML(geojsonData, internalName);
    else if (format === 'svg') svgContent = generateSVG(geojsonData, internalName);

    const zipPath = path.join(CACHE_DIR, `${id}_${format}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    return new Promise((resolve, reject) => {
        output.on('close', () => {
            res.download(zipPath, `${friendlyFilename}.zip`, (err) => {
                if (err) logger.error('下载错误: %s', err.message);
                try { fs.unlinkSync(zipPath); } catch (e) {}
                resolve();
            });
        });

        archive.on('error', reject);
        archive.pipe(output);

        switch (format) {
            case 'shp':
                if (shpFiles) {
                    for (const [ext, buffer] of Object.entries(shpFiles)) {
                        archive.append(buffer, { name: `${internalName}.${ext}` });
                    }
                } else {
                    archive.append(JSON.stringify(geojsonData, null, 2), { name: `${internalName}.geojson` });
                }
                break;
            case 'kml':
                archive.append(kmlContent || '', { name: `${internalName}.kml` });
                break;
            case 'gpkg':
                if (gpkgBuffer) archive.append(gpkgBuffer, { name: `${internalName}.gpkg` });
                else archive.append(JSON.stringify(geojsonData, null, 2), { name: `${internalName}.geojson` });
                break;
            case 'svg':
                archive.append(svgContent || generateSVG(geojsonData, internalName), { name: `${internalName}.svg` });
                break;
            default:
                archive.append(JSON.stringify(geojsonData, null, 2), { name: `${internalName}.geojson` });
        }

        if (fs.existsSync(qrcodePath)) archive.file(qrcodePath, { name: '关注公众号_锐多宝.jpg' });
        if (fs.existsSync(wechatPath)) archive.file(wechatPath, { name: '站长微信.png' });

        archive.append(getReadmeContent(regionName, id), { name: '说明.txt' });

        archive.finalize();
    });
}));

// 辅助函数：根据编码获取数据
async function getGsonDataByCode(dataCode, year) {
    if (/^\d{2}0000$/.test(dataCode)) {
        const availableYear = await findAvailableYear('SHENG', 'sheng', year, dataCode, 'first_gid');
        return await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "SHENG"."CHN_sheng_${availableYear}" WHERE first_gid = $1`, [dataCode]);
    } else if (/^\d{4}00$/.test(dataCode)) {
        const availableYear = await findAvailableYear('SHI', 'shi', year, dataCode, 'code');
        return await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "SHI"."CHN_shi_${availableYear}" WHERE code = $1`, [dataCode]);
    } else if (/^\d{6}$/.test(dataCode) && !/00$/.test(dataCode)) {
        const availableYear = await findAvailableYear('XIAN', 'xian', year, dataCode, 'code');
        return await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIAN"."CHN_xian_${availableYear}" WHERE code = $1`, [dataCode]);
    } else if (/^\d{12}$/.test(dataCode)) {
        if (dataCode.endsWith('000')) {
            return await query('SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIANG"."CHN_xiang_2020" WHERE code = $1', [dataCode]);
        }
        // 村级查询
        return await queryVillageDataByCode(dataCode);
    }
    return [];
}

async function queryVillageDataByCode(cunCode) {
    // 如果启用面数据，查询面数据
    if (config.village?.enablePolygon !== false) {
        // 查询面数据
        const shiCode = cunCode.substring(0, 4) + '00';
        const shengCode = cunCode.substring(0, 2) + '0000';

        for (const tableName of [shiCode, shengCode]) {
            const exists = await tableExists('cunpolygon', tableName);
            if (!exists) continue;

            const results = await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, name, cun_code
                                         FROM "cunpolygon"."${tableName}" WHERE cun_code = $1`, [cunCode]);
            if (results.length > 0) {
                return results.map(r => {
                    const geojsonGeom = JSON.parse(r.geojson_geom);
                    delete r.geojson_geom;
                    return { ...r, geojson_geom: JSON.stringify(geojsonGeom) };
                });
            }
        }
    }

    // 查询点数据
    const pointResults = await query(`SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, fullname as name, cuncode
                                       FROM "CUN"."chinacunpoint" WHERE cuncode = $1 LIMIT 1`, [cunCode]);

    return pointResults.map(r => {
        const geojsonGeom = JSON.parse(r.geojson_geom);
        delete r.geojson_geom;
        return { ...r, geojson_geom: JSON.stringify(geojsonGeom) };
    });
}

async function queryTownData(dataCode, placeName = null) {
    if (dataCode && /^\d{12}$/.test(dataCode)) {
        return await query('SELECT ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIANG"."CHN_xiang_2020" WHERE code = $1', [dataCode]);
    }
    if (placeName) {
        const sql = `SELECT DISTINCT ON (code) ST_AsGeoJSON(geom, 6) as geojson_geom, * FROM "XIANG"."CHN_xiang_2020"
            WHERE name = $1 OR name = $1 || '街道办事处' OR name = $1 || '街道' OR name = $1 || '镇' OR name LIKE '%' || $1 || '%' LIMIT 10`;
        return await query(sql, [placeName]);
    }
    return [];
}

async function findAvailableYear(schema, tableName, preferredYear, dataCode, codeField) {
    for (let y of [preferredYear, ...config.availableYears.filter(y => y !== preferredYear)]) {
        try {
            const result = await queryOne(`SELECT 1 FROM "${schema}"."CHN_${tableName}_${y}" WHERE ${codeField} = $1 LIMIT 1`, [dataCode]);
            if (result) return y;
        } catch (e) { continue; }
    }
    return preferredYear;
}

module.exports = router;