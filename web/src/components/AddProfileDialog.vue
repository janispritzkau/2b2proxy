<template>
  <Dialog ref="dialog" title="Add profile" :open="open" @update:open="$emit('update:open', $event)">
    <div class="tabs">
      <div
        v-for="(tab, i) in ['Account', 'Launcher profiles']"
        class="tab"
        :class="activeTab == i && 'selected'"
        :key="i"
        @click="activeTab = i"
      >{{ tab }}</div>
    </div>

    <div ref="content" class="content">
      <transition name="content" @enter="enter" @beforeLeave="beforeLeave" @afterEnter="afterEnter">
        <div v-if="activeTab == 0" :key="0">
          <p>Log in with your mojang account.</p>
          <p>
            Your credentials will only be used to create an access token
            which you can revoke by logging out the account in the launcher.
          </p>
          <form>
            <label class="label">Username / Email</label>
            <input type="email" class="input" v-model="username" autocomplete="none" />
            <label class="label">Password</label>
            <input
              type="password"
              class="input"
              v-model="password"
              autocomplete="none"
              @keydown.enter="addProfiles"
            />
          </form>
        </div>

        <div v-if="activeTab == 1" :key="1">
          <p>
            Upload the
            <code v-html="`.minecraft/<wbr>launcher_profiles.json`" /> file.
          </p>
          <p>
            Keep in mind that this will log you out from the launcher
            and you will need to relog again.
          </p>
          <input
            type="file"
            accept=".json"
            @change="uploadProfiles($event.target.files[0])"
            hidden
            class="input"
            id="fileUpload"
          />
          <label for="fileUpload" class="button raised primary">Upload file</label>

          <p v-if="invalidFile" class="error">Invalid file</p>
          <div v-else class="list">
            <div
              v-for="profile in profiles"
              :key="profile.id"
              class="item"
              @click="profile.selected = !profile.selected"
            >
              <i class="material-icons checkbox" :class="profile.selected && 'checked'" />
              <img class="avatar" :src="`https://crafatar.com/avatars/${profile.id}?size=64`" />
              <span>{{ profile.name }}</span>
            </div>
          </div>
        </div>
      </transition>
    </div>

    <template #actions>
      <button class="button" style="margin-right: 8px;" @click="$refs.dialog.close()">Cancel</button>
      <button class="button" @click="addProfiles" :disabled="disabled">Add {{ activeTab == 1 ? "profiles" : "profile" }}</button>
    </template>
  </Dialog>
</template>

<script>
import Dialog from "./Dialog.vue"

export default {
  components: {
    Dialog
  },
  props: {
    open: Boolean
  },
  data() {
    return {
      activeTab: 0,
      username: "",
      password: "",
      profiles: [],
      invalidFile: false,
      loading: false
    }
  },
  computed: {
    disabled() {
      if (this.loading) return true
      return this.activeTab == 0
        ? !this.username || !this.password
        : this.profiles.filter(p => p.selected).length == 0
    }
  },
  methods: {
    enter(element) {
      this.$refs.content.style.height = element.offsetHeight + 'px'
    },
    beforeLeave(element) {
      element.style.position = "absolute"
      this.$refs.content.style.height = element.offsetHeight + 'px'
    },
    afterEnter() {
      this.$refs.content.style.height = ""
    },
    async uploadProfiles(file) {
      const data = JSON.parse(await file.text())
      this.profiles = []
      try {
        for (const account of Object.values(data.authenticationDatabase)) {
          this.profiles.push(...Object.entries(account.profiles).map(([id, profile]) => ({
            id, name: profile.displayName,
            accessToken: account.accessToken,
            account: account.username,
            selected: true
          })))
        }
        this.invalidFile = false
      } catch {
        this.invalidFile = true
      }
    },
    async addProfiles() {
      if (this.disabled) return
      this.loading = true
      try {
        await new Promise(resolve => setTimeout(resolve, 500))
        const response = await fetch("/api/profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.activeTab == 0
            ? { username: this.username, password: this.password }
            : this.profiles.filter(profile => profile.selected))
        })
        if (response.ok) this.$emit("update:open", false)
      } catch { }
      this.loading = false
    }
  }
}
</script>

<style scoped>
.content {
  position: relative;
  overflow: hidden;
  transition: height 0.2s;
}

.content-enter-active,
.content-leave-active {
  width: 100%;
  overflow: hidden;
  transition: opacity 0.2s;
}

.content-enter,
.content-leave-to {
  opacity: 0;
}

.error {
  color: #ee2c2c;
  font-weight: 500;
}

.list {
  margin: 16px 0;
  padding: 0;
}

.list i {
  margin-right: 16px;
}

.checkbox.checked {
  color: var(--primary);
}

.checkbox:not(.checked) {
  opacity: 0.8;
}

.checkbox::before {
  content: "check_box_outline_blank";
}

.checkbox.checked::before {
  content: "check_box";
}
</style>
