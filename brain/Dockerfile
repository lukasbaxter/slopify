# Slopify brain. One file, one build arg for the card:
#   GPU=intel   Intel Arc / Battlemage (Level Zero)        -> :intel
#   GPU=nvidia  NVIDIA, driver 570+ (the CUDA libs come with torch) -> :nvidia
#   GPU=amd     AMD through ROCm (not tested on a real card yet)
#   GPU=cpu     no GPU: slow to learn new songs, fine to answer -> :cpu
FROM ubuntu:24.04
ARG GPU=intel
ARG ROCM=rocm6.4
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 HF_HOME=/data/hf \
    NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=compute,utility
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv ffmpeg \
 && if [ "$GPU" = intel ]; then \
      apt-get install -y --no-install-recommends software-properties-common gpg-agent \
      && add-apt-repository -y ppa:kobuk-team/intel-graphics && apt-get update \
      && apt-get install -y --no-install-recommends libze-intel-gpu1 libze1 intel-opencl-icd; \
    fi \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /venv
ENV PATH=/venv/bin:$PATH
RUN case "$GPU" in \
      intel) idx=xpu ;; nvidia) idx=cu128 ;; amd) idx=${ROCM:-rocm6.4} ;; cpu) idx=cpu ;; \
      *) echo "GPU must be intel, nvidia, amd or cpu" >&2; exit 1 ;; \
    esac \
 && pip install torch --index-url https://download.pytorch.org/whl/$idx
COPY requirements.txt /app/
RUN pip install -r /app/requirements.txt
COPY brain /app/brain
WORKDIR /app
ENV SLOPIFY_BRAIN_GPU=$GPU
EXPOSE 8097
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s CMD curl -fs http://127.0.0.1:8097/healthz || exit 1
CMD ["uvicorn", "brain.serve:app", "--host", "0.0.0.0", "--port", "8097"]
