<template>
  <div class="app" :class="!loginRequired && 'slide-' + slideDirection">
    <header v-if="!loginRequired">
      <div class="header">
        <button class="button" @click="($event.stopPropagation(), profilesMenu = !profilesMenu)">
          <span v-if="$store.currentProfile">
            Profile:
            <b>{{ $store.currentProfile.name }}</b>
          </span>
          <span v-else>No profile selected</span>
          <i v-if="$store.profiles.length > 0" class="material-icons">arrow_drop_down</i>
        </button>
        <div class="spacer" />
        <button class="icon-button" @click="settingsDialog = true">
          <i class="material-icons">settings</i>
        </button>
      </div>

      <div class="tabs">
        <div
          v-for="(tab, i) in ['Profiles', 'Chat']"
          :key="i"
          :class="activeTab == i && 'selected'"
          class="tab"
          @click="activeTab = i"
        >{{ tab }}</div>
      </div>
    </header>

    <transition name="main">
      <component :is="mainView" class="main" />
    </transition>

    <SettingsDialog :open.sync="settingsDialog" />

    <transition name="fade">
      <div v-if="profilesMenu" class="popup list" v-click-outside="() => profilesMenu = false">
        <div
          v-for="profile in $store.profiles"
          :key="profile.id"
          class="item"
          :class="profile.id == $store.selectedProfile && 'selected'"
          @click="($store.selectedProfile = profile.id, profilesMenu = false)"
        >{{ profile.name }}</div>
        <div
          v-if="$store.profiles.length == 0"
          class="item"
          @click="profilesMenu = false"
        >No profiles available</div>
      </div>
    </transition>
  </div>
</template>

<script>
import Profiles from "./views/Profiles.vue"
import Chat from "./views/Chat.vue"
import Login from "./views/Login.vue"
import SettingsDialog from "./components/SettingsDialog.vue"

export default {
  components: {
    SettingsDialog
  },
  directives: {
    clickOutside: {
      bind(el, binding, vnode) {
        binding.def.handleClick = event => {
          if (!el.contains(event.target)) binding.value()
        }
        document.body.addEventListener("click", binding.def.handleClick)
      },
      unbind(el, binding) {
        document.body.removeEventListener("click", binding.def.handleClick)
      }
    }
  },
  data() {
    return {
      user: null,
      activeTab: 0,
      profilesMenu: false,
      settingsDialog: false,
      slideDirection: "forward",
      loginRequired: false
    }
  },
  computed: {
    mainView() {
      return this.loginRequired ? Login : [Profiles, Chat][this.activeTab]
    }
  },
  created() {
    window.app = this
    this.$watch(() => this.loginRequired, () => this.slideDirection = null)
    this.$watch(() => this.activeTab, (value, prev) => {
      this.slideDirection = value > prev ? "forward" : "backward"
    })

    fetch("/api/me").then(async res => {
      if (res.status == 401) {
        this.loginRequired = true
        return
      }
      this.user = await res.json()
      if ("Notification" in window && navigator.serviceWorker) {
        navigator.serviceWorker.register("service-worker.js").then(async registration => {
          let subscription = await registration.pushManager.getSubscription()

          if (!subscription) {
            const response = await fetch("/api/push/server-key")
            const { serverKey } = await response.json()

            subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: serverKey
            })
          }

          fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(subscription)
          })
        })
      }
    })
  }
}

</script>

<style scoped>
.app {
  display: grid;
  grid-template: "header" "main";
  grid-template-rows: auto minmax(0, 1fr);
  height: var(--window-height);
  overflow-x: hidden;
}

.popup {
  position: absolute;
  min-width: 160px;
  top: 12px;
  left: 12px;
  padding: 12px 0;
  background: var(--background);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  border-radius: 3px;
  z-index: 100;
}

header {
  color: #fff;
  background: var(--primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  z-index: 2;
}

.header {
  display: flex;
  padding: 10px 12px 8px;
  align-items: center;
}

.header .button {
  color: inherit;
}

.spacer {
  flex-grow: 1;
}

.main {
  grid-area: main;
  background: var(--background-darker);
  overflow: auto;
}

.main-enter-active,
.main-leave-active {
  transition: all 0.2s;
}

.main-enter,
.main-leave-to {
  opacity: 0;
}

.slide-forward .main-enter,
.slide-backward .main-leave-to {
  transform: translateX(50%);
}

.slide-backward .main-enter,
.slide-forward .main-leave-to {
  transform: translateX(-50%);
}
</style>
