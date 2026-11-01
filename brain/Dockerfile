# Slopify brain: PyTorch on an Intel Arc GPU (Level Zero). For an NVIDIA
# card swap the base and the torch index (see README).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 HF_HOME=/data/hf
RUN apt-get update && apt-get install -y --no-install-recommends software-properties-common gpg-agent ca-certificates curl \
 && add-apt-repository -y ppa:kobuk-team/intel-graphics \
 && apt-get update && apt-get install -y --no-install-recommends \
    libze-intel-gpu1 libze1 intel-opencl-icd python3 python3-venv ffmpeg \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /venv
ENV PATH=/venv/bin:$PATH
ARG TORCH_INDEX=https://download.pytorch.org/whl/xpu
RUN pip install torch torchaudio --index-url $TORCH_INDEX
COPY requirements.txt /app/
RUN pip install -r /app/requirements.txt
COPY brain /app/brain
WORKDIR /app
EXPOSE 8097
CMD ["uvicorn", "brain.serve:app", "--host", "0.0.0.0", "--port", "8097"]
