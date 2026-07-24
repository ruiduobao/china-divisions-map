#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
导入全国村级面数据到 PostgreSQL/PostGIS
"""

import os
import subprocess
import psycopg2
from pathlib import Path

# 数据库连接配置
DB_CONFIG = {
    'host': 'localhost',
    'port': 5432,
    'database': 'shengshixian',
    'user': 'ruiduobao',
    'password': 'RDB123456.'
}

# 数据目录
DATA_DIR = '/opt/1panel/apps/openresty/openresty/www/wwwroot/map.ruiduobao.com/处理脚本/data/全国村'

def get_shp_files():
    """获取所有 shapefile 路径"""
    shp_files = []
    for root, dirs, files in os.walk(DATA_DIR):
        for f in files:
            if f.endswith('.shp') and f.startswith('_'):
                shp_files.append(os.path.join(root, f))
    return shp_files

def import_shp_to_postgis(shp_path, conn):
    """导入单个 shapefile 到 PostGIS"""
    # 从路径获取市级代码
    city_code = os.path.basename(os.path.dirname(shp_path))

    # 表名使用市级代码
    table_name = f'"{city_code}"'

    print(f"正在导入: {shp_path} -> cunpolygon.{city_code}")

    # 使用 shp2pgsql 导入
    cmd = [
        'shp2pgsql',
        '-s', '4490:4326',  # 坐标系转换
        '-I',  # 创建空间索引
        '-c',  # 创建新表
        shp_path,
        f'cunpolygon.{city_code}'
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"shp2pgsql 错误: {result.stderr}")
        return False

    # 执行 SQL
    try:
        cur = conn.cursor()
        cur.execute(result.stdout)
        conn.commit()
        print(f"成功导入: cunpolygon.{city_code}")
        return True
    except Exception as e:
        print(f"SQL 执行错误: {e}")
        conn.rollback()
        return False

def main():
    print("开始导入全国村级面数据...")

    # 连接数据库
    conn = psycopg2.connect(**DB_CONFIG)

    # 确保 cunpolygon schema 存在
    cur = conn.cursor()
    cur.execute("CREATE SCHEMA IF NOT EXISTS cunpolygon;")
    conn.commit()

    # 获取所有 shapefile
    shp_files = get_shp_files()
    print(f"找到 {len(shp_files)} 个 shapefile")

    # 导入每个文件
    success_count = 0
    for shp_path in shp_files:
        if import_shp_to_postgis(shp_path, conn):
            success_count += 1

    conn.close()

    print(f"\n导入完成: {success_count}/{len(shp_files)} 个文件成功")

if __name__ == '__main__':
    main()