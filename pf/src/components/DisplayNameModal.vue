<script setup lang="ts">
/**
 * 首次连接的玩家名输入对话框：
 * localStorage「DisplayName」无值时弹出，确认后由父组件保存并连接 PB。
 */
import { ref } from 'vue'

const emit = defineEmits<{ confirm: [name: string] }>()

const name = ref('')
const error = ref('')

function submit() {
  const v = name.value.trim()
  if (!v) {
    error.value = '请输入名字'
    return
  }
  if (v.length > 24) {
    error.value = '名字最长 24 个字符'
    return
  }
  emit('confirm', v)
}
</script>

<template>
  <div class="dm-mask">
    <div class="dm-card">
      <div class="dm-title">输入你的名字</div>
      <div class="dm-sub">联机对战需要玩家名，将保存在本浏览器</div>
      <input
        v-model="name"
        class="dm-input"
        maxlength="24"
        placeholder="1–24 个字符"
        autofocus
        @keyup.enter="submit"
      />
      <div v-if="error" class="dm-err">{{ error }}</div>
      <button class="dm-btn" :disabled="!name.trim()" @click="submit">进入房间</button>
    </div>
  </div>
</template>

<style scoped>
.dm-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(5, 10, 18, 0.72);
  backdrop-filter: blur(3px);
}
.dm-card {
  width: 320px;
  padding: 26px 28px 24px;
  border-radius: 14px;
  background: #101a26;
  border: 1px solid rgba(120, 180, 255, 0.25);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.dm-title {
  color: #e8f2fc;
  font-size: 18px;
  font-weight: 700;
  text-align: center;
}
.dm-sub {
  margin-top: 6px;
  color: rgba(180, 205, 230, 0.6);
  font-size: 12px;
  text-align: center;
}
.dm-input {
  width: 100%;
  box-sizing: border-box;
  margin-top: 18px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid rgba(120, 180, 255, 0.3);
  background: rgba(255, 255, 255, 0.06);
  color: #e8f2fc;
  font-size: 14px;
  outline: none;
}
.dm-input:focus {
  border-color: #6fc3ff;
  box-shadow: 0 0 0 2px rgba(111, 195, 255, 0.2);
}
.dm-err {
  margin-top: 8px;
  color: #ff8a7a;
  font-size: 12px;
}
.dm-btn {
  width: 100%;
  margin-top: 18px;
  padding: 10px 0;
  border: none;
  border-radius: 8px;
  background: linear-gradient(180deg, #3f9fff, #2a7fe0);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.dm-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.dm-btn:not(:disabled):hover {
  filter: brightness(1.1);
}
</style>
