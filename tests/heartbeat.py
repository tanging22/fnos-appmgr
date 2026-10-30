# 测试用：打三拍心跳，然后故意以 3 退出，看守护会不会把它拉起来
import sys, time
for i in range(1, 4):
    print(f"tick {i}", flush=True)
    time.sleep(1)
print("我故意崩一次", flush=True)
sys.exit(3)
