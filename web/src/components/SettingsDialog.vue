<template>
  <Dialog title="Settings" :open="open" @update:open="$emit('update:open', $event)">
    <form>
      <input autocomplete="username" hidden value="user" />
      <label class="label">Current password</label>
      <input
        type="password"
        class="input"
        v-model="currentPassword"
        autocomplete="current-password"
      />
      <label class="label">New password</label>
      <input type="password" class="input" v-model="newPassword" autocomplete="new-password" />
      <label class="label">Confirm password</label>
      <input
        type="password"
        autocomplete="new-password"
        class="input"
        v-model="confirmPassword"
        :class="{ invalid: confirmPassword && newPassword != confirmPassword }"
      />
    </form>
    <transition name="fade">
      <p v-if="error" class="error">{{ error }}</p>
    </transition>
    <template #actions>
      <button class="button">Logout (Janis)</button>
      <div class="spacer"></div>
      <button class="button">Cancel</button>
      <button class="button" @click="save" :disabled="disabled">Save</button>
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
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
      error: null
    }
  },
  watch: {
    open() {
      Object.assign(this.$data, this.$options.data.apply(this))
    }
  },
  computed: {
    disabled() {
      return this.currentPassword == "" || this.newPassword == "" || this.newPassword != this.confirmPassword
    }
  },
  methods: {
    async save() {
      try {
        const response = await fetch("/api/password", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword: this.currentPassword, newPassword: this.newPassword })
        })
        if (response.ok) {
          history.replaceState(null, "")
          this.$emit("update:open", false)
          this.error = null
        } else if (response.status == 403) {
          this.error = "Wrong current password"
        }
      } catch {
        this.error = "Connection error"
      }
    }
  }
}
</script>

<style scoped>
.spacer {
  flex-grow: 1;
}

.error {
  color: var(--secondary);
  font-weight: 500;
}
</style>
