<template>
  <main>
    <div class="chat">
      <div ref="content" class="content">
        <FormattedSpan v-for="line in lines" :key="line.key" :value="line.value" />
      </div>
      <div class="input-area">
        <input type="text" v-model="text" @keydown.enter="send" />
        <button class="icon-button send" @click="send">
          <svg viewBox="0 0 24 24" width="24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  </main>
</template>

<script>
import Vue from "vue"

const colorMap = {
  black: "#000000",
  dark_blue: "#0a28b4",
  dark_green: "#00b400",
  dark_aqua: "#32bebe",
  dark_red: "#d2140a",
  dark_purple: "#c832c8",
  gold: "#ffbe0a",
  gray: "#c8c8c8",
  dark_gray: "#646464",
  blue: "#6e6eff",
  green: "#55ff55",
  aqua: "#55ffff",
  red: "#ff645f",
  light_purple: "#ff6eff",
  yellow: "#ffff55",
  white: "#ffffff"
}

const FormattedSpan = Vue.extend({
  functional: true,
  props: {
    value: Object
  },
  render(h, context) {
    const { value: c } = context.props
    const style = {}, attrs = {}
    if (c.bold) style.fontWeight = "bold"
    if (c.italic) style.fontStyle = "italic"
    if (c.underlined) style.textDecoration = "underline"
    if (c.strikethrough) style.textDecoration = "line-through"
    if (c.color) style.color = colorMap[c.color]
    if (c.clickEvent && c.clickEvent.action == "open_url") {
      attrs.href = c.clickEvent.value
      attrs.target = "_blank"
    }
    return h(attrs.href ? "a" : "span", { style, attrs }, [c.text, c.extra && c.extra.map(c => h(FormattedSpan, { props: { value: c } }))])
  }
})

export default {
  components: {
    FormattedSpan
  },
  data() {
    return {
      text: ""
    }
  },
  computed: {
    lines() {
      return this.$store.chatBuffer[this.$store.selectedProfile] || []
    }
  },
  methods: {
    send(event) {
      this.$refs.content.scrollTop = this.$refs.content.scrollHeight
      this.$store.sendChatMessage(this.text)
      this.text = ""
    }
  },
  mounted() {
    const { content } = this.$refs
    let { scrollHeight } = content
    content.scrollTop = scrollHeight

    this.$watch("lines", () => {
      if (this.lines.length > 1000) this.lines = this.lines.slice(-900)
      if (scrollHeight - content.scrollTop < content.offsetHeight + 16) content.scrollTop = content.scrollHeight
      scrollHeight = content.scrollHeight
    })
  }
}
</script>

<style scoped>
main {
  display: flex;
  flex-direction: column;
}

.chat {
  display: flex;
  flex-direction: column;
  font-family: "Minecraft", monospace;
  font-size: 12px;
  line-height: 1.5;
  word-spacing: 0.125em;
  background: var(--background);
  flex-grow: 1;
  width: 100%;
  overflow: hidden;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
}

@media (min-width: 680px) {
  .chat {
    max-width: 640px;
    margin: 32px auto;
    border-radius: 4px;
  }
}

.content {
  flex-grow: 1;
  color: rgba(255, 255, 255, 0.9);
  padding: 12px 16px;
  background: #31343b;
  display: flex;
  flex-direction: column;
  white-space: pre-wrap;
  overflow: auto;
}

.content::before {
  content: "";
  flex-grow: 1;
}

.content > span {
  flex-shrink: 0;
  overflow: hidden;
}

.content a {
  color: inherit;
}

.input-area {
  display: flex;
  align-items: center;
  height: 48px;
  background: rgba(255, 255, 255, 0.08);
}

input {
  flex-grow: 1;
  background: none;
  border: none;
  height: 100%;
  padding: 0 16px;
  font: inherit;
  color: inherit;
  transition: background 0.1s;
}

input:focus {
  background: var(--contrast-3);
}

.send {
  margin: 0 4px;
  color: #10bbd1;
}
</style>
