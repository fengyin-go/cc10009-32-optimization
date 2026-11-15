import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import { ensureCleanseBaseline } from './data/cleanse-service'
import router from './router'
import './styles/global.css'

// 老数据迁移：补齐 CLEA-74 规则与映射清单的清洗版本，重复调用无副作用。
ensureCleanseBaseline()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
