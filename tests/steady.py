# 测试用：一直活着，用来验证停止和 kill 进程组
import sys, time
print("steady 起来了", flush=True)
n = 0
while True:
    n += 1
    print(f"alive {n}", flush=True)
    time.sleep(2)
