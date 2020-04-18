import "normalize.css"
import "./main.css"
import Vue from "vue"
import App from "./App.vue"
import store from "./store"

Vue.config.productionTip = false
Vue.prototype.$store = store

document.body.style.setProperty("--window-height", `${innerHeight}px`)

addEventListener("resize", () => {
  document.body.style.setProperty("--window-height", `${innerHeight}px`)
})

new Vue({
  render: h => h(App),
}).$mount("#app")
