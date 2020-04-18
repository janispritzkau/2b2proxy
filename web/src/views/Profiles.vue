<template>
  <main>
    <div class="container">
      <div class="buttons">
        <button class="button" @click="addDialog = true">Add profile</button>
        <div class="spacer" />
        <button
          class="button"
          :disabled="!$store.selectedProfile"
          @click="removeDialog = true"
        >Remove profile</button>
      </div>

      <div class="list">
        <div
          v-for="{ profile, connection } in profiles"
          :key="profile.id"
          class="item"
          :class="{ selected: profile.id == $store.selectedProfile }"
          @click="$store.selectedProfile = profile.id"
        >
          <img :src="`https://crafatar.com/avatars/${profile.id}?size=64`" />
          <span>{{ profile.name }}</span>
          <div v-if="!connection" class="chip disconnected">Disconnected</div>
          <div v-else-if="connection.playing" class="chip playing">Playing</div>
          <div
            v-else-if="connection.queue"
            class="chip queue"
          >{{ connection.queue.position }} in queue</div>
          <div v-else class="chip connected">Connected</div>
        </div>
        <p v-if="profiles.length == 0">No profiles added yet</p>
      </div>

      <transition name="fade">
        <button
          v-if="$store.currentProfile"
          class="button raised"
          :class="$store.connection ? 'secondary' : 'primary'"
          @click="$store.connection ? disconnect() : connect()"
          :disabled="connecting"
        >{{ $store.connection ? 'Disconnect' : 'Connect' }}</button>
      </transition>

      <transition name="fade">
        <section v-if="$store.connection && $store.connection.queue" class="info">
          <p>
            Position in queue:
            <b>{{ $store.connection.queue.position }}</b>
          </p>
          <p>
            Estimated time:
            <b>{{ $store.connection.queue.time }}</b>
          </p>
        </section>
      </transition>

      <transition name="fade">
        <section v-if="$store.connection" class="info">
          <p>
            Position:
            <b>{{ position.join(", ") }}</b>
          </p>
          <p>
            Dimension:
            <b>{{ dimension }}</b>
          </p>
        </section>
      </transition>
    </div>

    <AddProfileDialog :open.sync="addDialog" />

    <Dialog title="Remove profile" :open.sync="removeDialog">
      <template #default>
        <p>
          Do you really want to delete this profile:
          <b>{{ $store.currentProfile.name }}</b>
        </p>
      </template>
      <template #actions>
        <button class="button" @click="removeDialog = false">Cancel</button>
        <button class="button secondary" @click="deleteProfile">Delete profile</button>
      </template>
    </Dialog>
  </main>
</template>

<script>
import AddProfileDialog from "../components/AddProfileDialog.vue"
import Dialog from "../components/Dialog.vue"

export default {
  components: {
    AddProfileDialog,
    Dialog
  },
  data() {
    return {
      addDialog: false,
      removeDialog: false,
      connecting: false
    }
  },
  computed: {
    profiles() {
      return this.$store.profiles.map(profile => ({
        profile,
        connection: this.$store.connections[profile.id]
      }))
    },
    dimension() {
      switch (this.$store.connection.dimension) {
        case -1: return "Nether"
        case 0: return "Overworld"
        case 1: return "End"
        default: return "Other"
      }
    },
    position() {
      const player = this.$store.connection.player
      return [player.x, player.y, player.z]
    }
  },
  methods: {
    deleteProfile() {
      this.removeDialog = false
      fetch(`/api/profiles/${this.$store.currentProfile.id}`, { method: "DELETE" })
    },
    connect() {
      this.connecting = true
      this.$store.connect().then(() => this.connecting = false)
    },
    disconnect() {
      this.connecting = true
      this.$store.disconnect().then(() => this.connecting = false)
    }
  }
}
</script>

<style scoped>
main {
  padding-top: 32px;
}

.buttons {
  display: flex;
  margin-bottom: 8px;
}

.spacer {
  flex-grow: 1;
}

.list {
  border-radius: 4px;
  background: var(--background);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
  margin-bottom: 16px;
}

.list p {
  text-align: center;
  opacity: 0.5;
  user-select: none;
}

.chip {
  height: 32px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  line-height: 100%;
  font-size: 14px;
  border-radius: 16px;
  vertical-align: middle;
  background: var(--contrast-2);
}

.chip.queue {
  background: var(--primary);
}

.chip.playing {
  background: #117bdf;
}

.chip.connected {
  background: #16bd40;
}

.chip:not(.disconnected) {
  color: #fff;
}

section.info {
  font: 14px "Minecraft";
  margin: 32px 0;
}
</style>
