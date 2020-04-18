<template>
  <transition name="fade">
    <div
      v-if="open"
      class="dialog-container"
      :class="{ open }"
      @touchstart.self="clickOutside = true"
      @mousedown="clickOutside = $event.target == $el"
      @click="clickOutside && close($event)"
    >
      <div class="dialog" ref="dialog" tabindex="-1" @keydown.esc="close">
        <h3 class="title">{{ title }}</h3>
        <div class="content">
          <slot />
        </div>
        <div class="actions">
          <slot name="actions">
            <button class="button" @click="close">Close</button>
          </slot>
        </div>
      </div>
    </div>
  </transition>
</template>

<script>
export default {
  props: {
    open: Boolean,
    title: String
  },
  data() {
    return {
      clickOutside: true
    }
  },
  methods: {
    close(event) {
      if (event) event.stopPropagation()
      this.$emit("update:open", false)
    }
  },
  created() {
    this.$watch(() => this.open, () => {
      if (this.open) setTimeout(() => this.$refs.dialog.focus(), 100)
    })
  }
}
</script>


<style scoped>
.dialog-container {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  z-index: 100;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter,
.fade-leave-to {
  opacity: 0;
  pointer-events: none;
}

.fade-enter .dialog,
.fade-leave-to .dialog {
  transform: scale(0.75);
}

.dialog {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  background: var(--background);
  min-width: 240px;
  max-width: 560px;
  max-height: 100%;
  overflow: auto;
  width: 100%;
  border-radius: 3px;
  outline: 0;
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.2);
  transition: transform 0.2s ease-out;
}

.title,
.content,
.actions {
  padding: 0 24px;
}

.title {
  margin: 24px 0 16px;
}

.content {
  flex-grow: 1;
}

.actions {
  display: flex;
  justify-content: flex-end;
  margin: 24px 0 16px;
}
</style>
