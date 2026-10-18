"""
SCF（Stimulus Client Frontend，辅助意图层）——SSVEP 刺激呈现 Python 包。

基于 NDDrone-SDK 的「预渲染 PNG 帧 + PsychoPy waitBlanking 垂直同步」方案
独立实现，呈现 8 指令智能家居 SSVEP 闪烁刺激面板（2×4 网格）。

模块一览：
  config.json   8 条指令的频率 / 文字 / 颜色与全局呈现参数
  common.py     配置加载、2×4 网格布局、正弦亮度包络、中文字体加载
  gen_frames.py PIL 预渲染帧图生成器（先运行）
  stimulus.py   PsychoPy 全屏呈现主程序（后运行）
  preview.py    无 PsychoPy 的静态布局预览（随时可运行）

典型运行顺序：
  1) pip install -r scf/requirements.txt
  2) python scf/preview.py                 # 核对布局（可选）
  3) python scf/gen_frames.py --count 60   # 生成预渲染帧图
  4) python scf/stimulus.py                # 全屏呈现刺激
"""
