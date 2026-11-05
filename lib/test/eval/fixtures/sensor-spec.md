# Model X Environmental Sensor — Specification

The Model X sensor operates across a temperature range of **-20°C to 60°C**. It
samples at **100 Hz** and reports readings over an **I2C** bus at address **0x42**.

Supply voltage is 3.3V. The sensor draws 12 mA while sampling and 4 µA in sleep mode.
Firmware updates are delivered over the same I2C interface.
