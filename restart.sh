#!/bin/bash

# 通过进程名查找PID
PID=$(pgrep -f 'node server.js')

if [ -n "$PID" ]; then
    echo "进程已存在 (PID: $PID)，正在重启..."
    kill $PID
    # 等待进程完全终止
    while kill -0 $PID 2>/dev/null; do
        sleep 2
    done
else
    echo "进程不存在，正在启动..."
fi

# 启动进程并将输出重定向至日志文件
cd server
nohup node server.js > out.log 2>&1 &
NEW_PID=$!
echo "进程已启动，新PID: $NEW_PID"