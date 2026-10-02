import time
start=time.monotonic()
i=0
while time.monotonic()-start < 3600:
 print(f"YAM_MEMORY {i:06d} 中文 😀 " + "x"*96,flush=True)
 i+=1
 time.sleep(0.01)
assert i>0
